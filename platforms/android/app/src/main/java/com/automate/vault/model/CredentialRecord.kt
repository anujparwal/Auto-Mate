package com.automate.vault.model

import com.automate.vault.crypto.EncryptedPayload
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** Only V1 is allowed to contain plaintext metadata, pending an explicit authenticated upgrade. */
sealed class CredentialRecord {
    abstract val id: String
    abstract val version: Int
    abstract fun toJson(): JSONObject

    class V1(
        override val id: String,
        val origin: String,
        val username: String,
        val createdAt: Long,
        val updatedAt: Long,
        val encryptedPassword: EncryptedPayload
    ) : CredentialRecord() {
        override val version = 1
        init { VaultJson.requireOpaqueId(id) }
        override fun toString() = "CredentialRecord.V1(legacy, metadata=PROTECTED)"
        override fun toJson(): JSONObject = JSONObject().apply {
            put("version", 1)
            put("id", id)
            put("origin", origin)
            put("username", username)
            put("createdAt", createdAt)
            put("updatedAt", updatedAt)
            put("encryptedPassword", encryptedPassword.toJson())
        }
    }

    class V2(override val id: String, val iv: ByteArray, val ciphertext: ByteArray) : CredentialRecord() {
        override val version = 2
        init {
            VaultJson.requireOpaqueId(id)
            require(iv.size == 12) { "Invalid encrypted record IV." }
            require(ciphertext.size >= 16) { "Invalid encrypted record ciphertext." }
        }
        override fun toString() = "CredentialRecord.V2(metadata=PROTECTED)"
        override fun toJson(): JSONObject = JSONObject().apply {
            put("version", 2)
            put("id", id)
            put("iv", Base64.getEncoder().encodeToString(iv))
            put("ciphertext", Base64.getEncoder().encodeToString(ciphertext))
        }
    }

    companion object {
        private val v2Fields = setOf("version", "id", "iv", "ciphertext")
        private val v1Fields = setOf("id", "origin", "username", "createdAt", "encryptedPassword")
        private val v1Optional = setOf("version", "updatedAt")

        fun fromJson(json: JSONObject): CredentialRecord {
            val version = if (json.has("version")) VaultJson.long(json, "version") else 1L
            return when (version) {
                1L -> {
                    VaultJson.requireFields(json, v1Fields, v1Optional)
                    val id = VaultJson.string(json, "id")
                    require(id.isNotBlank()) { "Invalid legacy record identity." }
                    val encrypted = json.get("encryptedPassword")
                    require(encrypted is JSONObject) { "Invalid legacy ciphertext." }
                    V1(id, VaultJson.string(json, "origin"), VaultJson.string(json, "username"),
                        VaultJson.long(json, "createdAt"),
                        if (json.has("updatedAt")) VaultJson.long(json, "updatedAt") else VaultJson.long(json, "createdAt"),
                        EncryptedPayload.fromJson(encrypted))
                }
                2L -> {
                    VaultJson.requireFields(json, v2Fields)
                    V2(VaultJson.string(json, "id"),
                        Base64.getDecoder().decode(VaultJson.string(json, "iv")),
                        Base64.getDecoder().decode(VaultJson.string(json, "ciphertext")))
                }
                else -> throw IllegalArgumentException("Unsupported vault record version.")
            }
        }
    }
}

/** Strict vault-format parsing: no coercion of strings, numbers, or unknown plaintext properties. */
internal object VaultJson {
    fun requireFields(json: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
        for (field in required) require(json.has(field)) { "Missing vault property." }
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            require(key in required || key in optional) { "Unknown vault property." }
        }
    }
    fun string(json: JSONObject, field: String): String {
        val value = json.get(field)
        require(value is String) { "Invalid vault string property." }
        return value
    }
    fun long(json: JSONObject, field: String): Long {
        val value = json.get(field)
        require(value is Int || value is Long) { "Invalid vault numeric property." }
        return (value as Number).toLong()
    }
    fun requireOpaqueId(id: String) {
        require(UUID.fromString(id).toString() == id) { "Invalid opaque credential identity." }
    }
}
