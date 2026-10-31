package com.automate.vault.crypto

import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.util.concurrent.Executor
import javax.crypto.Cipher

/**
 * Manages BiometricPrompt device credential and strong biometric authentication
 * for hardware-bound cryptographic operations.
 */
class BiometricAuthHelper(
    private val activity: AppCompatActivity
) {

    sealed class AuthStatus {
        object Ready : AuthStatus()
        data class Unavailable(val reason: String, val canEnroll: Boolean) : AuthStatus()
    }

    private val executor: Executor = ContextCompat.getMainExecutor(activity)
    private val biometricManager = BiometricManager.from(activity)

    /**
     * Supported authenticators: Strong biometric or device credential (PIN/pattern/password) on API 30+.
     */
    val authenticators: Int
        get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        }

    /**
     * Checks if the device has enrolled biometrics or credentials ready for auth gating.
     */
    fun checkBiometricStatus(): AuthStatus {
        return when (biometricManager.canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> AuthStatus.Ready
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> AuthStatus.Unavailable(
                "No biometric or device screen lock enrolled. Please configure a PIN, pattern, or fingerprint in Android Settings.",
                canEnroll = true
            )
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> AuthStatus.Unavailable(
                "No secure biometric hardware detected on this device.",
                canEnroll = false
            )
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> AuthStatus.Unavailable(
                "Biometric hardware is currently unavailable.",
                canEnroll = false
            )
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> AuthStatus.Unavailable(
                "Security update required for biometric hardware.",
                canEnroll = false
            )
            else -> AuthStatus.Unavailable(
                "Biometric authentication is unavailable on this device.",
                canEnroll = false
            )
        }
    }

    /**
     * Prompts the user to authenticate an operation using a prepared Cipher.
     */
    fun authenticateWithCipher(
        cipher: Cipher,
        title: String,
        subtitle: String,
        onSuccess: (Cipher) -> Unit,
        onError: (code: Int, message: CharSequence) -> Unit,
        onCancel: () -> Unit
    ) {
        val promptInfoBuilder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            promptInfoBuilder.setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
        } else {
            promptInfoBuilder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            promptInfoBuilder.setNegativeButtonText("Cancel")
        }

        val promptInfo = promptInfoBuilder.build()

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                super.onAuthenticationSucceeded(result)
                val authenticatedCipher = result.cryptoObject?.cipher
                if (authenticatedCipher == null) {
                    onError(BiometricPrompt.ERROR_UNABLE_TO_PROCESS, "Authenticated cryptographic operation unavailable.")
                    return
                }
                onSuccess(authenticatedCipher)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                super.onAuthenticationError(errorCode, errString)
                when (errorCode) {
                    BiometricPrompt.ERROR_USER_CANCELED,
                    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> {
                        onCancel()
                    }
                    else -> {
                        onError(errorCode, errString)
                    }
                }
            }

            override fun onAuthenticationFailed() {
                super.onAuthenticationFailed()
                // Biometric did not match; framework automatically offers retries.
            }
        }

        val biometricPrompt = BiometricPrompt(activity, executor, callback)
        biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
    }
}
