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
import com.automate.vault.crypto.VaultPayloadCodec
import com.automate.vault.databinding.ActivityMainBinding
import com.automate.vault.databinding.DialogCreateCredentialBinding
import com.automate.vault.databinding.DialogRevealCredentialBinding
import com.automate.vault.model.CredentialRecord
import com.automate.vault.model.DecryptedCredential
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
 * - v2 records expose ONLY opaque ID, version, IV and ciphertext; metadata (origin, username, timestamps)
 *   is authenticated and encrypted inside the ciphertext.
 * - BiometricPrompt strong biometric / device credential gating for all cryptographic operations.
 * - Explicit owner-triggered 2-prompt authenticated upgrade for legacy v1 records.
 * - Fail-closed storage error handling: protects against silent data loss.
 * - Lifecycle-aware wipe of in-memory plaintext secrets and transient dialog state.
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
    private var activeDecryptedCredential: DecryptedCredential? = null
    private var autoClearTimer: CountDownTimer? = null
    private var activeRevealBinding: DialogRevealCredentialBinding? = null

    // Transient reference to active create dialog and secret memory
    private var activeCreateDialog: AlertDialog? = null
    private var activeCreateBinding: DialogCreateCredentialBinding? = null
    private var pendingPassword: CharArray? = null

    // Transient reference to active delete confirmation dialog
    private var activeDeleteDialog: AlertDialog? = null

    // Transient reference to pending legacy upgrade state (step 1 -> step 2)
    private class PendingUpgrade(
        val legacyRecord: CredentialRecord.V1,
        val secretChars: CharArray,
        val epoch: Int
    ) {
        fun wipe() {
            Arrays.fill(secretChars, '\u0000')
        }
    }
    private var pendingUpgrade: PendingUpgrade? = null

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
        activeCreateBinding?.etUsername?.text?.clear()
        activeCreateBinding?.etOrigin?.text?.clear()
        activeCreateDialog?.dismiss()
        activeCreateDialog = null
        activeCreateBinding = null

        // Immediately dismiss reveal dialog and wipe decrypted plaintext from memory
        dismissRevealDialogAndWipe()

        // Dismiss delete confirmation dialog
        activeDeleteDialog?.dismiss()
        activeDeleteDialog = null

        // Wipe any pending intermediate upgrade secrets
        pendingUpgrade?.wipe()
        pendingUpgrade = null
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
            onUpgradeClick = { record -> handleUpgradeCredential(record) },
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
            dialogBinding.etUsername.text?.clear()
            dialogBinding.etOrigin.text?.clear()
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
            val requestEpoch = ++authenticationEpoch
            val recordId = UUID.randomUUID().toString()

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
                            val decrypted = DecryptedCredential(
                                id = recordId,
                                origin = normalizedOrigin,
                                username = username,
                                password = passwordChars,
                                createdAt = System.currentTimeMillis(),
                                updatedAt = System.currentTimeMillis()
                            )
                            val record = VaultPayloadCodec.encrypt(authenticatedCipher, decrypted)
                            vaultStorage.saveCredential(record)
                            refreshCredentialsList()
                            dialog.dismiss()
                            showFeedback("Credential metadata encrypted with Keystore AES-GCM and saved.")
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

        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show()
    }

    private fun handleRevealCredential(record: CredentialRecord) {
        val requestEpoch = ++authenticationEpoch
        when (record) {
            is CredentialRecord.V2 -> {
                try {
                    val cipher = keystoreVault.initDecryptCipher(record.iv)

                    biometricAuthHelper.authenticateWithCipher(
                        cipher = cipher,
                        title = getString(R.string.biometric_reveal_title),
                        subtitle = getString(R.string.biometric_reveal_v2_subtitle),
                        onSuccess = success@ { authenticatedCipher ->
                            if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) return@success
                            try {
                                val decrypted = VaultPayloadCodec.decrypt(authenticatedCipher, record)
                                showRevealDialog(decrypted, isLegacy = false)
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
            is CredentialRecord.V1 -> {
                try {
                    val cipher = keystoreVault.initDecryptCipher(record.encryptedPassword.iv)
                    val aadData = KeystoreVault.computeAadV1(record.id, record.origin)

                    biometricAuthHelper.authenticateWithCipher(
                        cipher = cipher,
                        title = getString(R.string.biometric_reveal_title),
                        subtitle = getString(R.string.biometric_reveal_v1_subtitle),
                        onSuccess = success@ { authenticatedCipher ->
                            if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) return@success
                            try {
                                val secretChars = keystoreVault.decryptWithCipher(
                                    authenticatedCipher,
                                    record.encryptedPassword,
                                    aadData
                                )
                                val decrypted = DecryptedCredential(
                                    id = record.id,
                                    origin = record.origin,
                                    username = record.username,
                                    password = secretChars,
                                    createdAt = record.createdAt,
                                    updatedAt = record.updatedAt
                                )
                                showRevealDialog(decrypted, isLegacy = true)
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
        }
    }

    private fun showRevealDialog(credential: DecryptedCredential, isLegacy: Boolean) {
        dismissRevealDialogAndWipe()

        activeDecryptedCredential = credential
        val dialogBinding = DialogRevealCredentialBinding.inflate(LayoutInflater.from(this))
        activeRevealBinding = dialogBinding

        dialogBinding.tvRevealOrigin.text = credential.origin
        dialogBinding.tvRevealUsername.text = credential.username
        dialogBinding.tvDecryptedPassword.text = String(credential.password)
        dialogBinding.tvLegacyWarning.visibility = if (isLegacy) View.VISIBLE else View.GONE

        val dialog = MaterialAlertDialogBuilder(this)
            .setView(dialogBinding.root)
            .setCancelable(false)
            .create()

        activeRevealDialog = dialog

        // Clipboard copy with Android 13+ sensitive content flag
        dialogBinding.btnCopyPassword.setOnClickListener {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Vault Password", String(credential.password))
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

        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show()
    }

    private fun dismissRevealDialogAndWipe() {
        autoClearTimer?.cancel()
        autoClearTimer = null
        activeRevealBinding?.tvDecryptedPassword?.text = ""
        activeRevealBinding?.tvRevealOrigin?.text = ""
        activeRevealBinding?.tvRevealUsername?.text = ""
        activeRevealBinding = null

        activeRevealDialog?.dismiss()
        activeRevealDialog = null

        activeDecryptedCredential?.wipe()
        activeDecryptedCredential = null
    }

    private fun handleDeleteCredential(record: CredentialRecord) {
        val requestEpoch = ++authenticationEpoch
        when (record) {
            is CredentialRecord.V2 -> {
                try {
                    val cipher = keystoreVault.initDecryptCipher(record.iv)

                    biometricAuthHelper.authenticateWithCipher(
                        cipher = cipher,
                        title = getString(R.string.biometric_delete_title),
                        subtitle = getString(R.string.biometric_delete_subtitle),
                        onSuccess = success@ { authenticatedCipher ->
                            if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) return@success
                            val decrypted = try {
                                VaultPayloadCodec.decrypt(authenticatedCipher, record)
                            } catch (e: Exception) {
                                showFeedback("Failed to authenticate credential for deletion: ${e.message}")
                                return@success
                            }
                            showDeleteConfirmationDialog(
                                recordId = record.id,
                                origin = decrypted.origin,
                                username = decrypted.username,
                                onDismissCleanup = { decrypted.wipe() }
                            )
                        },
                        onError = { _, message ->
                            showFeedback("Authentication error: $message")
                        },
                        onCancel = {
                            showFeedback(getString(R.string.auth_cancelled))
                        }
                    )
                } catch (e: Exception) {
                    showFeedback("Keystore initialization error: ${e.message}")
                }
            }
            is CredentialRecord.V1 -> {
                try {
                    val cipher = keystoreVault.initDecryptCipher(record.encryptedPassword.iv)
                    val aadData = KeystoreVault.computeAadV1(record.id, record.origin)

                    biometricAuthHelper.authenticateWithCipher(
                        cipher = cipher,
                        title = getString(R.string.biometric_delete_title),
                        subtitle = getString(R.string.biometric_delete_subtitle),
                        onSuccess = success@ { authenticatedCipher ->
                            if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) return@success
                            try {
                                val secret = keystoreVault.decryptWithCipher(
                                    authenticatedCipher,
                                    record.encryptedPassword,
                                    aadData
                                )
                                Arrays.fill(secret, '\u0000')
                            } catch (e: Exception) {
                                showFeedback("Failed to authenticate legacy record for deletion: ${e.message}")
                                return@success
                            }
                            showDeleteConfirmationDialog(
                                recordId = record.id,
                                origin = record.origin,
                                username = record.username,
                                onDismissCleanup = {}
                            )
                        },
                        onError = { _, message ->
                            showFeedback("Authentication error: $message")
                        },
                        onCancel = {
                            showFeedback(getString(R.string.auth_cancelled))
                        }
                    )
                } catch (e: Exception) {
                    showFeedback("Keystore initialization error: ${e.message}")
                }
            }
        }
    }

    private fun showDeleteConfirmationDialog(
        recordId: String,
        origin: String,
        username: String,
        onDismissCleanup: () -> Unit
    ) {
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.action_delete)
            .setMessage(getString(R.string.delete_confirmation_message, origin, username))
            .setPositiveButton(R.string.action_delete) { _, _ ->
                try {
                    vaultStorage.deleteCredential(recordId)
                    refreshCredentialsList()
                    showFeedback("Credential deleted.")
                } catch (e: VaultStorageException) {
                    showFeedback("Delete failed: ${e.message}")
                }
            }
            .setNegativeButton(R.string.action_cancel, null)
            .setOnDismissListener {
                onDismissCleanup()
                activeDeleteDialog = null
            }
            .create()

        activeDeleteDialog = dialog
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show()
    }

    private fun handleUpgradeCredential(record: CredentialRecord.V1) {
        try {
            val decryptCipher = keystoreVault.initDecryptCipher(record.encryptedPassword.iv)
            val v1Aad = KeystoreVault.computeAadV1(record.id, record.origin)
            val requestEpoch = ++authenticationEpoch

            // Step 1: Authenticate to decrypt legacy secret
            biometricAuthHelper.authenticateWithCipher(
                cipher = decryptCipher,
                title = getString(R.string.biometric_upgrade_step1_title),
                subtitle = getString(R.string.biometric_upgrade_step1_subtitle),
                onSuccess = step1Success@ { authenticatedDecryptCipher ->
                    if (requestEpoch != authenticationEpoch || isFinishing || isDestroyed) {
                        return@step1Success
                    }
                    val secretChars = try {
                        keystoreVault.decryptWithCipher(
                            authenticatedDecryptCipher,
                            record.encryptedPassword,
                            v1Aad
                        )
                    } catch (e: Exception) {
                        showFeedback("Decryption failed during upgrade: ${e.message}")
                        return@step1Success
                    }

                    pendingUpgrade?.wipe()
                    val currentPending = PendingUpgrade(record, secretChars, requestEpoch)
                    pendingUpgrade = currentPending

                    // Step 2: Authenticate to encrypt full payload into v2 envelope
                    executeUpgradeStep2(currentPending)
                },
                onError = { _, message ->
                    showFeedback("Upgrade authentication error: $message")
                },
                onCancel = {
                    showFeedback(getString(R.string.upgrade_cancelled))
                }
            )
        } catch (e: Exception) {
            showFeedback("Keystore initialization error: ${e.message}")
        }
    }

    private fun executeUpgradeStep2(pending: PendingUpgrade) {
        try {
            val encryptCipher = keystoreVault.initEncryptCipher()
            val requestEpoch = authenticationEpoch
            val record = pending.legacyRecord

            biometricAuthHelper.authenticateWithCipher(
                cipher = encryptCipher,
                title = getString(R.string.biometric_upgrade_step2_title),
                subtitle = getString(R.string.biometric_upgrade_step2_subtitle),
                onSuccess = step2Success@ { authenticatedEncryptCipher ->
                    if (requestEpoch != authenticationEpoch || requestEpoch != pending.epoch || isFinishing || isDestroyed) {
                        pending.wipe()
                        if (pendingUpgrade === pending) pendingUpgrade = null
                        return@step2Success
                    }
                    try {
                        val decrypted = DecryptedCredential(
                            id = record.id,
                            origin = record.origin,
                            username = record.username,
                            password = pending.secretChars,
                            createdAt = record.createdAt,
                            updatedAt = record.updatedAt
                        )
                        val v2Record = VaultPayloadCodec.encrypt(authenticatedEncryptCipher, decrypted)

                        // Atomically replace legacy record with encrypted v2 envelope
                        vaultStorage.saveCredential(v2Record)
                        refreshCredentialsList()
                        showFeedback(getString(R.string.upgrade_success))
                    } catch (e: Exception) {
                        showFeedback("Upgrade encryption failed: ${e.message}. Legacy record preserved.")
                    } finally {
                        pending.wipe()
                        if (pendingUpgrade === pending) pendingUpgrade = null
                    }
                },
                onError = { _, message ->
                    pending.wipe()
                    if (pendingUpgrade === pending) pendingUpgrade = null
                    showFeedback("Upgrade step 2 authentication error: $message. Legacy record preserved.")
                },
                onCancel = {
                    pending.wipe()
                    if (pendingUpgrade === pending) pendingUpgrade = null
                    showFeedback(getString(R.string.upgrade_cancelled))
                }
            )
        } catch (e: Exception) {
            pending.wipe()
            if (pendingUpgrade === pending) pendingUpgrade = null
            showFeedback("Keystore step 2 initialization error: ${e.message}")
        }
    }

    private fun showFeedback(message: String) {
        Snackbar.make(binding.coordinatorLayout, message, Snackbar.LENGTH_SHORT).show()
    }
}
