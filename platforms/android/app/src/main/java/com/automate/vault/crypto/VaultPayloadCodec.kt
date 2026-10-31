package com.automate.vault.crypto

import com.automate.vault.model.CredentialRecord
import com.automate.vault.model.DecryptedCredential
import com.automate.vault.model.VaultJson
import com.automate.vault.policy.OriginValidator
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher

/** Same envelope implementation for authenticated Android ciphers and real JCE host verification. */
object VaultPayloadCodec {
    private val fields = setOf("id", "origin", "username", "password", "createdAt", "updatedAt")

    private fun aad(id: String): ByteArray = "AutoMate:v2:id=$id:version=2".toByteArray(StandardCharsets.UTF_8)

    fun encode(credential: DecryptedCredential): ByteArray {
        VaultJson.requireOpaqueId(credential.id)
        require(OriginValidator.normalizeOrThrow(credential.origin) == credential.origin) { "Noncanonical credential origin." }
        require(credential.username.isNotEmpty() && credential.password.isNotEmpty()) { "Empty credential data." }
        return JSONObject().apply {
            put("id", credential.id)
            put("origin", credential.origin)
            put("username", credential.username)
            put("password", String(credential.password))
            put("createdAt", credential.createdAt)
            put("updatedAt", credential.updatedAt)
        }.toString().toByteArray(StandardCharsets.UTF_8)
    }

    fun decode(payloadBytes: ByteArray, expectedId: String): DecryptedCredential {
        try {
            VaultJson.requireOpaqueId(expectedId)
            val json = JSONObject(String(payloadBytes, StandardCharsets.UTF_8))
            VaultJson.requireFields(json, fields)
            val id = VaultJson.string(json, "id")
            if (id != expectedId) throw SecurityException("Credential identity mismatch.")
            val origin = VaultJson.string(json, "origin")
            if (OriginValidator.normalizeOrThrow(origin) != origin) throw SecurityException("Noncanonical credential origin.")
            val username = VaultJson.string(json, "username")
            val password = VaultJson.string(json, "password")
            require(username.isNotEmpty() && password.isNotEmpty()) { "Empty credential data." }
            val createdAt = VaultJson.long(json, "createdAt")
            val updatedAt = VaultJson.long(json, "updatedAt")
            return DecryptedCredential(id, origin, username, password.toCharArray(), createdAt, updatedAt)
        } catch (_: Exception) {
            // JSON errors can include plaintext snippets; do not attach them as causes or expose them in UI.
            throw SecurityException("Invalid authenticated credential payload.")
        }
    }

    /** Cipher must be initialized and authorized by the platform before invoking this operation. */
    fun encrypt(cipher: Cipher, credential: DecryptedCredential): CredentialRecord.V2 {
        val plaintext = encode(credential)
        try {
            cipher.updateAAD(aad(credential.id))
            val ciphertext = cipher.doFinal(plaintext)
            return CredentialRecord.V2(credential.id, cipher.iv, ciphertext)
        } finally { plaintext.fill(0) }
    }

    /** Identity and metadata are returned only after GCM authentication and strict inner validation. */
    fun decrypt(cipher: Cipher, record: CredentialRecord.V2): DecryptedCredential {
        cipher.updateAAD(aad(record.id))
        val plaintext = cipher.doFinal(record.ciphertext)
        try { return decode(plaintext, record.id) }
        finally { plaintext.fill(0) }
    }
}
