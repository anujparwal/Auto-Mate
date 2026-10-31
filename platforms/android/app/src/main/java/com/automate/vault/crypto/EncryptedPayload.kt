package com.automate.vault.crypto

import android.util.Base64
import org.json.JSONObject

/**
 * Encrypted payload containing AES-GCM ciphertext, initialization vector, and authentication tag.
 * Serializes safely to and from JSON.
 */
data class EncryptedPayload(
    val iv: ByteArray,
    val ciphertext: ByteArray
) {
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
            put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
        }
    }

    companion object {
        fun fromJson(json: JSONObject): EncryptedPayload {
            val ivBase64 = json.getString("iv")
            val cipherBase64 = json.getString("ciphertext")
            return EncryptedPayload(
                iv = Base64.decode(ivBase64, Base64.NO_WRAP),
                ciphertext = Base64.decode(cipherBase64, Base64.NO_WRAP)
            )
        }
    }
}
