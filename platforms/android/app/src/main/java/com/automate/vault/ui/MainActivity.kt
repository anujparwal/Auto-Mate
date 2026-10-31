package com.automate.vault.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.CountDownTimer
import android.os.PersistableBundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import com.automate.vault.R
import com.automate.vault.crypto.BiometricAuthHelper
import com.automate.vault.crypto.KeystoreVault
import com.automate.vault.crypto.PasswordGenerator
import com.automate.vault.databinding.ActivityMainBinding
import com.automate.vault.databinding.DialogCreateCredentialBinding
import com.automate.vault.databinding.DialogRevealCredentialBinding
import com.automate.vault.model.CredentialRecord
import com.automate.vault.policy.OriginValidator
import com.automate.vault.storage.VaultStorage
import com.automate.vault.storage.VaultStorageException
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import java.util.Arrays
import java.util.UUID

/**
 * Main Activity for Auto-Mate Native Android Vault.
 * Security guarantees:
 * - WindowManager.LayoutParams.FLAG_SECURE to prevent task-switcher screenshot / recording leaks.
 * - Hardware-backed Android Keystore AES-256-GCM encryption with mandatory user authentication.
 * - Ciphertext bound to record ID and exact origin via GCM Additional Authenticated Data (AAD).
 * - BiometricPrompt strong biometric / device credential gating.
 * - Fail-closed storage error handling: protects against silent data loss.
 * - Lifecycle-aware wipe of in-memory plaintext secrets.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var adapter: CredentialAdapter

    private val keystoreVault by lazy { KeystoreVault() }
    private val biometricAuthHelper by lazy { BiometricAuthHelper(this) }
    private val vaultStorage by lazy { VaultStorage(this) }
    private val passwordGenerator by lazy { PasswordGenerator() }

    // Transient reference to active reveal dialog and secret memory
    private var activeRevealDialog: AlertDialog? = null
    private var activeSecretChars: CharArray? = null
    private var autoClearTimer: CountDownTimer? = null
    private var activeRevealBinding: DialogRevealCredentialBinding? = null
    private var activeCreateDialog: AlertDialog? = null
    private var activeCreateBinding: DialogCreateCredentialBinding? = null
    private var pendingPassword: CharArray? = null
    private var authenticationEpoch = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        // Enforce FLAG_SECURE before window content is created
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupWindowInsets()
        setupRecyclerView()
        setupListeners()
    }

    override fun onResume() {
        super.onResume()
        updateSecurityStatus()
        refreshCredentialsList()
    }

    override fun onStop() {
        super.onStop()
        authenticationEpoch++
        pendingPassword?.fill('\u0000')
        pendingPassword = null
        activeCreateBinding?.etPassword?.text?.clear()
        activeCreateDialog?.dismiss()
        activeCreateDialog = null
        activeCreateBinding = null
        // Immediately dismiss dialog and wipe any plaintext from memory on backgrounding
        dismissRevealDialogAndWipe()
    }

    private fun setupWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.coordinatorLayout) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
    }

    private fun setupRecyclerView() {
        adapter = CredentialAdapter(
            onRevealClick = { record -> handleRevealCredential(record) },
            onDeleteClick = { record -> handleDeleteCredential(record) }
        )
        binding.recyclerViewCredentials.layoutManager = LinearLayoutManager(this)
        binding.recyclerViewCredentials.adapter = adapter
    }

    private fun setupListeners() {
        binding.fabAddCredential.setOnClickListener {
            showCreateCredentialDialog()
        }

        binding.btnSettingsAction.setOnClickListener {
            val intent = Intent(Settings.ACTION_SECURITY_SETTINGS)
            startActivity(intent)
        }
    }

    private fun updateSecurityStatus() {
        when (val status = biometricAuthHelper.checkBiometricStatus()) {
            is BiometricAuthHelper.AuthStatus.Ready -> {
                val assurance = keystoreVault.getSecurityAssurance()
                val assuranceLabel = when (assurance) {
                    KeystoreVault.SecurityAssurance.HARDWARE_TEE_OR_STRONGBOX ->
                        "Hardware-Backed (TEE/StrongBox) Keystore Active"
                    KeystoreVault.SecurityAssurance.SOFTWARE_KEYMASTER ->
                        "Software Keystore Active (TEE absent on device)"
                    KeystoreVault.SecurityAssurance.UNKNOWN ->
                        "Android Keystore Active"
                }

                binding.cardStatusBanner.setCardBackgroundColor(
                    getColor(R.color.vault_primary_container)
                )
                binding.tvStatusText.text = "$assuranceLabel • Auth-Gated"
                binding.btnSettingsAction.visibility = View.GONE
                binding.fabAddCredential.isEnabled = true
            }
            is BiometricAuthHelper.AuthStatus.Unavailable -> {
                binding.cardStatusBanner.setCardBackgroundColor(
                    getColor(R.color.vault_error_container)
                )
                binding.tvStatusText.text = status.reason
                binding.btnSettingsAction.visibility = if (status.canEnroll) View.VISIBLE else View.GONE
                binding.fabAddCredential.isEnabled = false
            }
        }
    }

    private fun refreshCredentialsList() {
        try {
            val list = vaultStorage.loadCredentials()
            adapter.submitList(list)
            if (list.isEmpty()) {
                binding.layoutEmptyState.visibility = View.VISIBLE
                binding.recyclerViewCredentials.visibility = View.GONE
            } else {
                binding.layoutEmptyState.visibility = View.GONE
                binding.recyclerViewCredentials.visibility = View.VISIBLE
            }
        } catch (e: VaultStorageException) {
            // Fail closed: alert the user and disable additions to prevent silent overwrite
            binding.cardStatusBanner.setCardBackgroundColor(getColor(R.color.vault_error_container))
            binding.tvStatusText.text = "Vault storage corrupted. Write operations disabled to prevent data loss."
            binding.fabAddCredential.isEnabled = false
            binding.layoutEmptyState.visibility = View.VISIBLE
            binding.recyclerViewCredentials.visibility = View.GONE
            showFeedback("Vault storage error: ${e.message}")
        }
    }

    private fun showCreateCredentialDialog() {
        val dialogBinding = DialogCreateCredentialBinding.inflate(LayoutInflater.from(this))
        val dialog = MaterialAlertDialogBuilder(this)
            .setView(dialogBinding.root)
            .setCancelable(false)
            .create()
        activeCreateDialog = dialog
        activeCreateBinding = dialogBinding
        dialog.setOnDismissListener {
            dialogBinding.etPassword.text?.clear()
            activeCreateBinding = null
            activeCreateDialog = null
        }

        // Generate password button
        dialogBinding.btnGeneratePassword.setOnClickListener {
            val generated = passwordGenerator.generatePassword(20)
            dialogBinding.etPassword.setText(String(generated))
            passwordGenerator.wipe(generated)
        }

        dialogBinding.btnCancelCreate.setOnClickListener {
            dialog.dismiss()
        }

        dialogBinding.btnSaveCredential.setOnClickListener {
            val originRaw = dialogBinding.etOrigin.text?.toString().orEmpty()
            val username = dialogBinding.etUsername.text?.toString().orEmpty().trim()
            val passwordStr = dialogBinding.etPassword.text?.toString().orEmpty()

            // Validate origin strictly per Auto-Mate policy
            val originValidation = OriginValidator.validate(originRaw)
            if (originValidation is OriginValidator.Result.Invalid) {
                dialogBinding.tilOrigin.error = originValidation.reason
                return@setOnClickListener
            } else {
                dialogBinding.tilOrigin.error = null
            }

            if (username.isEmpty()) {
                dialogBinding.tilUsername.error = "Username is required."
                return@setOnClickListener
            } else {
                dialogBinding.tilUsername.error = null
            }

            if (passwordStr.isEmpty()) {
                dialogBinding.tilPassword.error = "Password is required."
                return@setOnClickListener
            } else {
                dialogBinding.tilPassword.error = null
            }

            val normalizedOrigin = (originValidation as OriginValidator.Result.Valid).normalizedOrigin
            val passwordChars = passwordStr.toCharArray()
            pendingPassword?.fill('\u0000')
            pendingPassword = passwordChars
            val requestEpoch = authenticationEpoch
            val recordId = UUID.randomUUID().toString()
            val aadData = KeystoreVault.computeAad(recordId, normalizedOrigin)

            // Authenticate operation via BiometricPrompt before encrypting
            try {
                val cipher = keystoreVault.initEncryptCipher()
                biometricAuthHelper.authenticateWithCipher(
                    cipher = cipher,
                    title = getString(R.string.biometric_save_title),
                    subtitle = getString(R.string.biometric_save_subtitle),
                    onSuccess = success@ { authenticatedCipher ->
                        if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) {
                            passwordChars.fill('\u0000')
                            return@success
                        }
                        try {
                            val encryptedPayload = keystoreVault.encryptWithCipher(
                                authenticatedCipher,
                                passwordChars,
                                aadData
                            )
                            val record = CredentialRecord(
                                id = recordId,
                                origin = normalizedOrigin,
                                username = username,
                                encryptedPassword = encryptedPayload
                            )
                            vaultStorage.saveCredential(record)
                            refreshCredentialsList()
                            dialog.dismiss()
                            showFeedback("Credential encrypted with Keystore AES-GCM and saved.")
                        } catch (e: Exception) {
                            showFeedback("Encryption error: ${e.message}")
                        } finally {
                            Arrays.fill(passwordChars, '\u0000')
                        }
                    },
                    onError = { _, message ->
                        Arrays.fill(passwordChars, '\u0000')
                        showFeedback("Authentication error: $message")
                    },
                    onCancel = {
                        Arrays.fill(passwordChars, '\u0000')
                        showFeedback(getString(R.string.auth_cancelled))
                    }
                )
            } catch (e: Exception) {
                Arrays.fill(passwordChars, '\u0000')
                showFeedback("Keystore initialization error: ${e.message}")
            }
        }

        dialog.show()
    }

    private fun handleRevealCredential(record: CredentialRecord) {
        try {
            val cipher = keystoreVault.initDecryptCipher(record.encryptedPassword.iv)
            val aadData = KeystoreVault.computeAad(record.id, record.origin)
            val requestEpoch = authenticationEpoch

            biometricAuthHelper.authenticateWithCipher(
                cipher = cipher,
                title = getString(R.string.biometric_reveal_title),
                subtitle = "${record.origin} (${record.username})",
                onSuccess = success@ { authenticatedCipher ->
                    if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) return@success
                    try {
                        val decrypted = keystoreVault.decryptWithCipher(
                            authenticatedCipher,
                            record.encryptedPassword,
                            aadData
                        )
                        showRevealDialog(record, decrypted)
                    } catch (e: Exception) {
                        showFeedback("Decryption failed (tag or AAD mismatch): ${e.message}")
                    }
                },
                onError = { _, message ->
                    showFeedback("Authentication error: $message")
                },
                onCancel = {
                    showFeedback(getString(R.string.auth_cancelled))
                }
            )
        } catch (e: Exception) {
            showFeedback("Keystore decrypt error: ${e.message}")
        }
    }

    private fun showRevealDialog(record: CredentialRecord, secret: CharArray) {
        dismissRevealDialogAndWipe()

        activeSecretChars = secret
        val dialogBinding = DialogRevealCredentialBinding.inflate(LayoutInflater.from(this))
        activeRevealBinding = dialogBinding

        dialogBinding.tvRevealOrigin.text = record.origin
        dialogBinding.tvRevealUsername.text = record.username
        dialogBinding.tvDecryptedPassword.text = String(secret)

        val dialog = MaterialAlertDialogBuilder(this)
            .setView(dialogBinding.root)
            .setCancelable(false)
            .create()

        activeRevealDialog = dialog

        // Clipboard copy with Android 13+ sensitive content flag
        dialogBinding.btnCopyPassword.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Vault Password", String(secret))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                clip.description.extras = PersistableBundle().apply {
                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
            }
            clipboard.setPrimaryClip(clip)
            showFeedback(getString(R.string.copied_to_clipboard))
        }

        dialogBinding.btnCloseReveal.setOnClickListener {
            dismissRevealDialogAndWipe()
        }

        // Auto-clear 30s countdown timer
        dialogBinding.progressAutoClear.max = 30
        dialogBinding.progressAutoClear.progress = 30
        dialogBinding.tvAutoClearTimer.text = "30s"

        autoClearTimer = object : CountDownTimer(30000, 1000) {
            override fun onTick(millisUntilFinished: Long) {
                val secondsRemaining = (millisUntilFinished / 1000).toInt()
                dialogBinding.progressAutoClear.progress = secondsRemaining
                dialogBinding.tvAutoClearTimer.text = "${secondsRemaining}s"
            }

            override fun onFinish() {
                dismissRevealDialogAndWipe()
                showFeedback("Revealed password cleared from memory.")
            }
        }.start()

        dialog.show()
    }

    private fun dismissRevealDialogAndWipe() {
        autoClearTimer?.cancel()
        autoClearTimer = null
        activeRevealBinding?.tvDecryptedPassword?.text = ""
        activeRevealBinding = null

        activeRevealDialog?.dismiss()
        activeRevealDialog = null

        activeSecretChars?.let {
            passwordGenerator.wipe(it)
        }
        activeSecretChars = null
    }

    private fun handleDeleteCredential(record: CredentialRecord) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.action_delete)
            .setMessage("Permanently remove credential for ${record.origin} (${record.username})?")
            .setPositiveButton("Delete") { _, _ ->
                try {
                    vaultStorage.deleteCredential(record.id)
                    refreshCredentialsList()
                    showFeedback("Credential deleted.")
                } catch (e: VaultStorageException) {
                    showFeedback("Delete failed: ${e.message}")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showFeedback(message: String) {
        Snackbar.make(binding.coordinatorLayout, message, Snackbar.LENGTH_SHORT).show()
    }
}
