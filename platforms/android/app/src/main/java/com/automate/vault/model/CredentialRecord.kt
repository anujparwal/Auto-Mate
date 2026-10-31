package com.automate.vault.model

import com.automate.vault.crypto.EncryptedPayload
import org.json.JSONObject
import java.util.UUID

/**
 * Representation of an origin-bound credential record stored in the native vault.
 * Metadata (origin, username, timestamps) is accessible for UI listing.
 * The password secret is encrypted using device-bound Android Keystore AES-GCM.
 */
data class CredentialRecord(
    val id: String = UUID.randomUUID().toString(),
    val origin: String,
    val username: String,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val encryptedPassword: EncryptedPayload
) {
    fun toJson(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("origin", origin)
            put("username", username)
            put("createdAt", createdAt)
            put("updatedAt", updatedAt)
            put("encryptedPassword", encryptedPassword.toJson())
        }
    }

    companion object {
        fun fromJson(json: JSONObject): CredentialRecord {
            return CredentialRecord(
                id = json.getString("id"),
                origin = json.getString("origin"),
                username = json.getString("username"),
                createdAt = json.getLong("createdAt"),
                updatedAt = json.optLong("updatedAt", json.getLong("createdAt")),
                encryptedPassword = EncryptedPayload.fromJson(json.getJSONObject("encryptedPassword"))
            )
        }
    }
}
