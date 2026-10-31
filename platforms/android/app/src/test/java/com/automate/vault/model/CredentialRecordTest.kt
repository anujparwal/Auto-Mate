package com.automate.vault.model

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class CredentialRecordTest {
    private val id = "4d6d63ef-97b7-4c31-8ca6-d6211ad4742a"

    private fun envelope(): JSONObject = JSONObject().apply {
        put("version", 2)
        put("id", id)
        put("iv", Base64.getEncoder().encodeToString(ByteArray(12)))
        put("ciphertext", Base64.getEncoder().encodeToString(ByteArray(32)))
    }

    @Test fun plaintextOrUnknownFieldsCannotBeSilentlyAcceptedAndRewritten() {
        for (field in listOf("origin", "username", "createdAt", "updatedAt", "password", "encryptedPassword", "email", "label")) {
            val json = envelope().put(field, "private-account-value")
            assertThrows(IllegalArgumentException::class.java) { CredentialRecord.fromJson(json) }
        }
    }

    @Test fun malformedEnvelopeTypesAndSizesAreRejected() {
        val cases = listOf(
            envelope().put("version", "2"), envelope().put("version", 1), envelope().put("version", 99),
            envelope().put("id", "private-user@example.test"), envelope().put("id", 42),
            envelope().put("iv", Base64.getEncoder().encodeToString(ByteArray(11))),
            envelope().put("ciphertext", Base64.getEncoder().encodeToString(ByteArray(15)))
        )
        for (json in cases) assertThrows(IllegalArgumentException::class.java) { CredentialRecord.fromJson(json) }
    }

    @Test fun originalUnversionedLegacyFixtureRetainsIdentityAndTimestampsUntilAuthenticatedUpgrade() {
        // Original application format, not a fixture emitted by the new serializer.
        val json = JSONObject("""{
            "id":"4d6d63ef-97b7-4c31-8ca6-d6211ad4742a",
            "origin":"https://legacy.example.test",
            "username":"legacy-owner@example.test",
            "createdAt":1700000000000,
            "updatedAt":1700000005000,
            "encryptedPassword":{"iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAAAAAAA="}
        }""")
        val legacy = CredentialRecord.fromJson(json) as CredentialRecord.V1
        assertEquals(id, legacy.id)
        assertEquals("https://legacy.example.test", legacy.origin)
        assertEquals("legacy-owner@example.test", legacy.username)
        assertEquals(1700000000000L, legacy.createdAt)
        assertEquals(1700000005000L, legacy.updatedAt)
        assertFalse(legacy.toString().contains(legacy.origin))
        assertFalse(legacy.toString().contains(legacy.username))
    }
}
