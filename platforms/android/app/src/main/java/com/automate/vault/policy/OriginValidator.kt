package com.automate.vault.policy

import java.net.URI

/**
 * Validates and normalizes origins according to Auto-Mate security policy.
 * Binds credentials strictly to normalized HTTPS origins (protocol, host, and optional port).
 */
object OriginValidator {

    sealed class Result {
        data class Valid(val normalizedOrigin: String) : Result()
        data class Invalid(val reason: String) : Result()
    }

    /**
     * Validates that an origin string is a canonical HTTPS origin.
     * Rejects HTTP, userinfo, non-root paths, query parameters, and fragments.
     */
    fun validate(input: String): Result {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return Result.Invalid("Origin cannot be empty.")
        }

        val uri = try {
            URI(trimmed)
        } catch (e: Exception) {
            return Result.Invalid("Malformed URL: ${e.message}")
        }

        if (uri.scheme == null || !uri.scheme.equals("https", ignoreCase = true)) {
            return Result.Invalid("Only secure HTTPS origins are permitted (got: ${uri.scheme ?: "none"}).")
        }

        if (!uri.userInfo.isNullOrEmpty()) {
            return Result.Invalid("Origin must not contain embedded user credentials.")
        }

        val host = uri.host
        if (host.isNullOrEmpty()) {
            return Result.Invalid("Origin must contain a valid hostname.")
        }

        val path = uri.rawPath
        if (!path.isNullOrEmpty() && path != "/") {
            return Result.Invalid("Origin must not specify a subpath (got: '$path'). Origin-bound policy requires base origin only.")
        }

        if (!uri.rawQuery.isNullOrEmpty()) {
            return Result.Invalid("Origin must not contain query parameters.")
        }

        if (!uri.rawFragment.isNullOrEmpty()) {
            return Result.Invalid("Origin must not contain URL fragments.")
        }

        val normalized = if (uri.port != -1 && uri.port != 443) {
            "https://${host.lowercase()}:${uri.port}"
        } else {
            "https://${host.lowercase()}"
        }

        return Result.Valid(normalized)
    }

    /**
     * Normalizes the origin, or throws IllegalArgumentException if invalid.
     */
    @Throws(IllegalArgumentException::class)
    fun normalizeOrThrow(input: String): String {
        return when (val result = validate(input)) {
            is Result.Valid -> result.normalizedOrigin
            is Result.Invalid -> throw IllegalArgumentException(result.reason)
        }
    }
}
