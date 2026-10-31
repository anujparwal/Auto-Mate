package com.automate.vault.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PasswordGeneratorTest {

    private val generator = PasswordGenerator()

    @Test
    fun testGeneratedPasswordRequirements() {
        val length = 24
        val password = generator.generatePassword(length)

        assertEquals(length, password.size)

        var hasLower = false
        var hasUpper = false
        var hasDigit = false
        var hasSymbol = false

        val symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?"

        for (c in password) {
            when {
                c.isLowerCase() -> hasLower = true
                c.isUpperCase() -> hasUpper = true
                c.isDigit() -> hasDigit = true
                symbols.contains(c) -> hasSymbol = true
            }
        }

        assertTrue("Must contain lowercase", hasLower)
        assertTrue("Must contain uppercase", hasUpper)
        assertTrue("Must contain digit", hasDigit)
        assertTrue("Must contain symbol", hasSymbol)

        // Test wiping
        generator.wipe(password)
        assertTrue("Password array must be zeroized after wipe", password.all { it == '\u0000' })
    }

    @Test
    fun testLengthBounds() {
        val tooShort = generator.generatePassword(5)
        assertTrue(tooShort.size >= PasswordGenerator.MIN_LENGTH)

        val tooLong = generator.generatePassword(100)
        assertTrue(tooLong.size <= PasswordGenerator.MAX_LENGTH)
    }
}
