package com.automate.vault.crypto

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.Arrays
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore AES-256-GCM vault manager.
 * Strictly enforces user authentication (Biometric Strong or Device Credential)
 * for all cryptographic operations and binds records to Additional Authenticated Data (AAD).
 */
class KeystoreVault(
    private val keyAlias: String = DEFAULT_KEY_ALIAS
) {

    companion object {
        const val DEFAULT_KEY_ALIAS = "AutoMate_Vault_MasterKey"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val AES_GCM_NOPADDING = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val KEY_SIZE_BITS = 256

        /**
         * Computes canonical Additional Authenticated Data (AAD) to cryptographically
         * bind the ciphertext to a specific record ID and exact normalized origin.
         */
        fun computeAad(recordId: String, origin: String): ByteArray {
            return "AutoMate:v1:id=${recordId}:origin=${origin}".toByteArray(StandardCharsets.UTF_8)
        }
    }

    enum class SecurityAssurance {
        HARDWARE_TEE_OR_STRONGBOX,
        SOFTWARE_KEYMASTER,
        UNKNOWN
    }

    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
        load(null)
    }

    /**
     * Retrieves or generates the master key.
     * Always enforces user authentication.
     * If an existing key lacks required user authentication, it is rejected with a SecurityException.
     */
    @Synchronized
    fun getOrCreateMasterKey(): SecretKey {
        if (keyStore.containsAlias(keyAlias)) {
            val entry = keyStore.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry
            if (entry != null) {
                val existingKey = entry.secretKey
                validateKeyAuthPolicy(existingKey)
                return existingKey
            }
        }

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE
        )

        val builder = KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0, // 0 = Per-operation authentication required
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        keyGenerator.init(builder.build())
        val newKey = keyGenerator.generateKey()
        validateKeyAuthPolicy(newKey)
        return newKey
    }

    /**
     * Inspects key policy to guarantee user authentication is required.
     * Never accepts an unauthenticated key.
     */
    private fun validateKeyAuthPolicy(secretKey: SecretKey) {
        try {
            val factory = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
            val keyInfo = factory.getKeySpec(secretKey, KeyInfo::class.java) as KeyInfo
            if (!keyInfo.isUserAuthenticationRequired) {
                throw SecurityException(
                    "Security policy violation: Master key '$keyAlias' does not require user authentication. Rejecting insecure key."
                )
            }
        } catch (e: Exception) {
            throw SecurityException("Unable to verify authenticated key policy.", e)
        }
    }

    /**
     * Accurately determines if the key is inside dedicated secure hardware (TEE/StrongBox)
     * or software-emulated keymaster.
     */
    fun getSecurityAssurance(): SecurityAssurance {
        return try {
            val secretKey = getOrCreateMasterKey()
            val factory = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
            val keyInfo = factory.getKeySpec(secretKey, KeyInfo::class.java) as KeyInfo
            if (keyInfo.isInsideSecureHardware) {
                SecurityAssurance.HARDWARE_TEE_OR_STRONGBOX
            } else {
                SecurityAssurance.SOFTWARE_KEYMASTER
            }
        } catch (e: Exception) {
            SecurityAssurance.UNKNOWN
        }
    }

    /**
     * Prepares a Cipher in ENCRYPT mode to be wrapped in BiometricPrompt.CryptoObject.
     */
    fun initEncryptCipher(): Cipher {
        val masterKey = getOrCreateMasterKey()
        val cipher = Cipher.getInstance(AES_GCM_NOPADDING)
        cipher.init(Cipher.ENCRYPT_MODE, masterKey)
        return cipher
    }

    /**
     * Prepares a Cipher in DECRYPT mode to be wrapped in BiometricPrompt.CryptoObject.
     */
    fun initDecryptCipher(iv: ByteArray): Cipher {
        val masterKey = getOrCreateMasterKey()
        val cipher = Cipher.getInstance(AES_GCM_NOPADDING)
        val spec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
        cipher.init(Cipher.DECRYPT_MODE, masterKey, spec)
        return cipher
    }

    /**
     * Encrypts plaintext using an authenticated Cipher and binds to Additional Authenticated Data (AAD).
     * Plaintext bytes are wiped from memory immediately after encryption.
     */
    fun encryptWithCipher(
        cipher: Cipher,
        secret: CharArray,
        aadData: ByteArray
    ): EncryptedPayload {
        cipher.updateAAD(aadData)
        val plaintextBytes = charsToBytes(secret)
        try {
            val ciphertext = cipher.doFinal(plaintextBytes)
            return EncryptedPayload(
                iv = cipher.iv,
                ciphertext = ciphertext
            )
        } finally {
            Arrays.fill(plaintextBytes, 0.toByte())
        }
    }

    /**
     * Decrypts ciphertext using an authenticated Cipher and verifies Additional Authenticated Data (AAD).
     * Intermediate plaintext bytes are wiped from memory immediately.
     */
    fun decryptWithCipher(
        cipher: Cipher,
        payload: EncryptedPayload,
        aadData: ByteArray
    ): CharArray {
        cipher.updateAAD(aadData)
        val plaintextBytes = cipher.doFinal(payload.ciphertext)
        try {
            return bytesToChars(plaintextBytes)
        } finally {
            Arrays.fill(plaintextBytes, 0.toByte())
        }
    }

    private fun charsToBytes(chars: CharArray): ByteArray {
        val charBuffer = CharBuffer.wrap(chars)
        val byteBuffer: ByteBuffer = StandardCharsets.UTF_8.encode(charBuffer)
        val bytes = ByteArray(byteBuffer.remaining())
        byteBuffer.get(bytes)
        return bytes
    }

    private fun bytesToChars(bytes: ByteArray): CharArray {
        val byteBuffer = ByteBuffer.wrap(bytes)
        val charBuffer: CharBuffer = StandardCharsets.UTF_8.decode(byteBuffer)
        val chars = CharArray(charBuffer.remaining())
        charBuffer.get(chars)
        return chars
    }
}
