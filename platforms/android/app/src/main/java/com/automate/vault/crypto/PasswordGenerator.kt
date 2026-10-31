package com.automate.vault.crypto

import java.security.SecureRandom
import java.util.Arrays

/**
 * Cryptographically secure password generator using java.security.SecureRandom.
 * Guarantees unbiased distribution across selected character sets.
 */
class PasswordGenerator(
    private val secureRandom: SecureRandom = SecureRandom()
) {

    companion object {
        const val DEFAULT_LENGTH = 20
        const val MIN_LENGTH = 12
        const val MAX_LENGTH = 64

        private const val LOWERCASE = "abcdefghijklmnopqrstuvwxyz"
        private const val UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        private const val DIGITS = "0123456789"
        private const val SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?"
        private const val ALL_CHARS = LOWERCASE + UPPERCASE + DIGITS + SYMBOLS
    }

    /**
     * Generates a high-entropy password character array.
     * Guarantees at least one lowercase, uppercase, digit, and symbol.
     */
    fun generatePassword(length: Int = DEFAULT_LENGTH): CharArray {
        val effectiveLength = length.coerceIn(MIN_LENGTH, MAX_LENGTH)
        val password = CharArray(effectiveLength)

        // Ensure character class coverage
        password[0] = LOWERCASE[secureRandom.nextInt(LOWERCASE.length)]
        password[1] = UPPERCASE[secureRandom.nextInt(UPPERCASE.length)]
        password[2] = DIGITS[secureRandom.nextInt(DIGITS.length)]
        password[3] = SYMBOLS[secureRandom.nextInt(SYMBOLS.length)]

        // Fill remainder uniformly from combined set
        for (i in 4 until effectiveLength) {
            password[i] = ALL_CHARS[secureRandom.nextInt(ALL_CHARS.length)]
        }

        // Unbiased Fisher-Yates shuffle
        for (i in effectiveLength - 1 downTo 1) {
            val j = secureRandom.nextInt(i + 1)
            val temp = password[i]
            password[i] = password[j]
            password[j] = temp
        }

        return password
    }

    /**
     * Wipes a sensitive character array from memory.
     */
    fun wipe(chars: CharArray) {
        Arrays.fill(chars, '\u0000')
    }
}
