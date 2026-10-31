package com.automate.vault.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginValidatorTest {

    @Test
    fun testValidOrigins() {
        val r1 = OriginValidator.validate("https://example.com")
        assertTrue(r1 is OriginValidator.Result.Valid)
        assertEquals("https://example.com", (r1 as OriginValidator.Result.Valid).normalizedOrigin)

        val r2 = OriginValidator.validate("https://sub.domain.local:8443/")
        assertTrue(r2 is OriginValidator.Result.Valid)
        assertEquals("https://sub.domain.local:8443", (r2 as OriginValidator.Result.Valid).normalizedOrigin)

        val r3 = OriginValidator.validate("HTTPS://EXAMPLE.COM")
        assertTrue(r3 is OriginValidator.Result.Valid)
        assertEquals("https://example.com", (r3 as OriginValidator.Result.Valid).normalizedOrigin)
    }

    @Test
    fun testInvalidOriginsRejected() {
        // HTTP rejected
        assertTrue(OriginValidator.validate("http://example.com") is OriginValidator.Result.Invalid)

        // Subpath rejected
        assertTrue(OriginValidator.validate("https://example.com/login") is OriginValidator.Result.Invalid)

        // Query params rejected
        assertTrue(OriginValidator.validate("https://example.com?query=1") is OriginValidator.Result.Invalid)

        // Fragment rejected
        assertTrue(OriginValidator.validate("https://example.com#section") is OriginValidator.Result.Invalid)

        // Embedded credentials rejected
        assertTrue(OriginValidator.validate("https://user:pass@example.com") is OriginValidator.Result.Invalid)

        // Empty string rejected
        assertTrue(OriginValidator.validate("") is OriginValidator.Result.Invalid)
    }
}
