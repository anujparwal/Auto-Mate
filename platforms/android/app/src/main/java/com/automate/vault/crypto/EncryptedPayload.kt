package com.automate.vault.crypto

import com.automate.vault.model.VaultJson
import org.json.JSONObject
import java.util.Base64

/**
 * Encrypted payload containing AES-GCM ciphertext, initialization vector, and authentication tag.
 * Serializes safely to and from JSON.
 */
data class EncryptedPayload(
    val iv: ByteArray,
    val ciphertext: ByteArray
) {
    init {
        require(iv.size == 12) { "AES-GCM IV must be exactly 12 bytes, got ${iv.size}" }
        require(ciphertext.size >= 16) { "AES-GCM ciphertext must be at least 16 bytes (tag), got ${ciphertext.size}" }
    }

    override fun toString(): String {
        return "EncryptedPayload(ivLen=${iv.size}, cipherLen=${ciphertext.size})"
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as EncryptedPayload
        if (!iv.contentEquals(other.iv)) return false
        if (!ciphertext.contentEquals(other.ciphertext)) return false
        return true
    }

    override fun hashCode(): Int {
        var result = iv.contentHashCode()
        result = 31 * result + ciphertext.contentHashCode()
        return result
    }

    fun toJson(): JSONObject {
        return JSONObject().apply {
            put("iv", Base64.getEncoder().encodeToString(iv))
            put("ciphertext", Base64.getEncoder().encodeToString(ciphertext))
        }
    }

    companion object {
        private val fields = setOf("iv", "ciphertext")
        fun fromJson(json: JSONObject): EncryptedPayload {
            VaultJson.requireFields(json, fields)
            val ivBase64 = VaultJson.string(json, "iv")
            val cipherBase64 = VaultJson.string(json, "ciphertext")
            val iv = try {
                Base64.getDecoder().decode(ivBase64)
            } catch (e: Exception) {
                throw IllegalArgumentException("Malformed base64 IV: ${e.message}")
            }
            val ciphertext = try {
                Base64.getDecoder().decode(cipherBase64)
            } catch (e: Exception) {
                throw IllegalArgumentException("Malformed base64 ciphertext: ${e.message}")
            }
            return EncryptedPayload(iv, ciphertext)
        }
    }
}
