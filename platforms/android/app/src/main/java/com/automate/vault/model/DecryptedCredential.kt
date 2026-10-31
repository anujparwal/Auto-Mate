package com.automate.vault.model

import java.util.Arrays

/**
 * Ephemeral in-memory representation of an authenticated, decrypted credential record.
 * Holds sensitive plaintext fields (origin, username, password, timestamps).
 * Never logged or exposed via default toString().
 * Explicit wipe() method zeroizes the sensitive password character array.
 */
class DecryptedCredential(
    val id: String,
    val origin: String,
    val username: String,
    val password: CharArray,
    val createdAt: Long,
    val updatedAt: Long
) {
    /**
     * Prevents accidental logging or disclosure of sensitive secrets.
     */
    override fun toString(): String {
        return "DecryptedCredential(metadata=PROTECTED, password=PROTECTED)"
    }

    fun wipe() {
        Arrays.fill(password, '\u0000')
    }

}
