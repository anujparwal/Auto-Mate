package com.automate.vault.storage

import android.content.Context
import android.util.AtomicFile
import com.automate.vault.model.CredentialRecord
import org.json.JSONArray
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets

/**
 * Exception thrown when vault storage cannot be safely loaded or parsed.
 * Ensures the app fails closed rather than silently wiping data on corruption.
 */
class VaultStorageException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * File-backed persistence for encrypted vault records.
 * Stored in noBackupFilesDir with android:allowBackup="false" and dataExtractionRules configured
 * to exclude vault data from cloud backups.
 * Employs AtomicFile with .bak recovery to protect against mid-write crashes.
 */
class VaultStorage(context: Context) {

    private val storageFile = File(context.noBackupFilesDir, "vault_records.json")
    private val backupFile = File(storageFile.path + ".bak")
    private val atomicFile = AtomicFile(storageFile)

    /**
     * Loads credentials from disk.
     * Recovers from .bak if the base file was interrupted during an atomic write.
     * Fails closed: throws VaultStorageException if disk data is corrupted or unreadable.
     */
    @Synchronized
    @Throws(VaultStorageException::class)
    fun loadCredentials(): List<CredentialRecord> {
        // Only return empty if neither base nor backup file exists
        if (!storageFile.exists() && !backupFile.exists()) {
            return emptyList()
        }

        var fis: FileInputStream? = null
        try {
            // AtomicFile.openRead() automatically rolls back to backupFile if base is missing/broken
            fis = atomicFile.openRead()
            val available = fis.available()
            val bytes = ByteArray(available)
            var totalRead = 0
            while (totalRead < available) {
                val read = fis.read(bytes, totalRead, available - totalRead)
                if (read < 0) break
                totalRead += read
            }

            val jsonString = String(bytes, 0, totalRead, StandardCharsets.UTF_8).trim()
            if (jsonString.isEmpty()) {
                // Fail closed: existing file is empty or truncated
                throw VaultStorageException("Vault storage file exists but is empty or truncated. Refusing to load.")
            }

            val jsonArray = JSONArray(jsonString)
            val list = mutableListOf<CredentialRecord>()
            val seenIds = mutableSetOf<String>()
            for (i in 0 until jsonArray.length()) {
                val itemObj = jsonArray.optJSONObject(i)
                    ?: throw VaultStorageException("Vault record at index $i is not a JSON object")
                val record = try {
                    CredentialRecord.fromJson(itemObj)
                } catch (e: Exception) {
                    throw VaultStorageException("Vault record failed schema validation.")
                }
                if (!seenIds.add(record.id)) {
                    throw VaultStorageException("Duplicate credential identities in vault.")
                }
                list.add(record)
            }
            return list
        } catch (e: VaultStorageException) {
            throw e
        } catch (e: Exception) {
            // Fail closed: never return emptyList() on read/parse error
            throw VaultStorageException("Vault storage could not be loaded.")
        } finally {
            try {
                fis?.close()
            } catch (_: IOException) {}
        }
    }

    /**
     * Atomically saves or updates a credential record.
     * Reads current state first; if current state is corrupted, refuses to write to prevent data loss.
     */
    @Synchronized
    @Throws(VaultStorageException::class)
    fun saveCredential(record: CredentialRecord.V2) {
        val current = loadCredentials().toMutableList()
        val index = current.indexOfFirst { it.id == record.id }
        if (index >= 0) {
            current[index] = record
        } else {
            current.add(0, record)
        }
        persistList(current)
    }

    /**
     * Atomically deletes a credential record by ID.
     */
    @Synchronized
    @Throws(VaultStorageException::class)
    fun deleteCredential(id: String): Boolean {
        val current = loadCredentials().toMutableList()
        val removed = current.removeAll { it.id == id }
        if (removed) {
            persistList(current)
        }
        return removed
    }

    @Synchronized
    fun clearAll() {
        if (storageFile.exists() || backupFile.exists()) {
            atomicFile.delete()
        }
    }

    private fun persistList(list: List<CredentialRecord>) {
        val jsonArray = JSONArray()
        for (item in list) {
            jsonArray.put(item.toJson())
        }
        val bytes = jsonArray.toString(2).toByteArray(StandardCharsets.UTF_8)

        var fos: FileOutputStream? = null
        try {
            fos = atomicFile.startWrite()
            fos.write(bytes)
            fos.flush()
            atomicFile.finishWrite(fos)
        } catch (e: IOException) {
            if (fos != null) {
                atomicFile.failWrite(fos)
            }
            throw VaultStorageException("Vault storage write failed. Reopen the vault before retrying.")
        }
    }
}
