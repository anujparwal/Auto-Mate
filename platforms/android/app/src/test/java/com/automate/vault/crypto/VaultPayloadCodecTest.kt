package com.automate.vault.crypto

import com.automate.vault.model.CredentialRecord
import com.automate.vault.model.DecryptedCredential
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Real production envelope operations with JCE ciphers; does not simulate Android authentication. */
class VaultPayloadCodecTest {
    private val id = "b3a4a159-86ce-4d56-8a58-fd9cb030a5f3"
    private val otherId = "30e666a0-4054-46df-9d32-bbdcbbaae278"

    private fun details() = DecryptedCredential(id, "https://private.example.test:8443", "private-owner@example.test",
        "synthetic-password-私密!".toCharArray(), 1730000000000L, 1730000050000L)

    private fun key(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private fun encryptCipher(key: SecretKey): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
    private fun decryptCipher(key: SecretKey, record: CredentialRecord.V2): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record.iv))
    }

    @Test fun persistedEnvelopeHidesMetadataAndRecoversAllAuthenticatedFields() {
        val key = key()
        val original = details()
        val envelope = VaultPayloadCodec.encrypt(encryptCipher(key), original)
        val stored = envelope.toJson().toString()
        assertFalse(stored.contains(original.origin))
        assertFalse(stored.contains(original.username))
        assertFalse(stored.contains(String(original.password)))
        val parsed = CredentialRecord.fromJson(JSONObject(stored)) as CredentialRecord.V2
        val recovered = VaultPayloadCodec.decrypt(decryptCipher(key, parsed), parsed)
        assertEquals(original.id, recovered.id)
        assertEquals(original.origin, recovered.origin)
        assertEquals(original.username, recovered.username)
        assertArrayEquals(original.password, recovered.password)
        assertEquals(original.createdAt, recovered.createdAt)
        assertEquals(original.updatedAt, recovered.updatedAt)
        original.wipe()
        recovered.wipe()
        assertTrue(recovered.password.all { it == '\u0000' })
    }

    @Test fun movedEnvelopeAndModifiedCiphertextCannotReleaseMetadata() {
        val key = key()
        val envelope = VaultPayloadCodec.encrypt(encryptCipher(key), details())
        val moved = CredentialRecord.V2(otherId, envelope.iv, envelope.ciphertext)
        assertThrows(AEADBadTagException::class.java) { VaultPayloadCodec.decrypt(decryptCipher(key, moved), moved) }
        val damagedBytes = envelope.ciphertext.copyOf()
        damagedBytes[damagedBytes.lastIndex] = (damagedBytes.last().toInt() xor 1).toByte()
        val damaged = CredentialRecord.V2(id, envelope.iv, damagedBytes)
        assertThrows(AEADBadTagException::class.java) { VaultPayloadCodec.decrypt(decryptCipher(key, damaged), damaged) }
    }

    @Test fun malformedAuthenticatedPayloadsAreRejectedRatherThanCoerced() {
        val valid = String(VaultPayloadCodec.encode(details()), Charsets.UTF_8)
        val malformed = listOf(
            JSONObject(valid).put("id", otherId),
            JSONObject(valid).put("origin", "http://unsafe.example.test"),
            JSONObject(valid).put("username", 42),
            JSONObject(valid).put("updatedAt", "1730000050000"),
            JSONObject(valid).apply { remove("updatedAt") },
            JSONObject(valid).put("unexpectedMetadata", "not-supported")
        )
        for (json in malformed) assertThrows(SecurityException::class.java) {
            VaultPayloadCodec.decode(json.toString().toByteArray(Charsets.UTF_8), id)
        }
    }

    @Test fun diagnosticStringsRevealNeitherMetadataNorPassword() {
        val original = details()
        val diagnostic = original.toString()
        assertFalse(diagnostic.contains(original.origin))
        assertFalse(diagnostic.contains(original.username))
        assertFalse(diagnostic.contains(original.createdAt.toString()))
        assertFalse(diagnostic.contains(String(original.password)))
        original.wipe()
    }
}
