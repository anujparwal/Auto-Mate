package com.automate.vault.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.automate.vault.R
import com.automate.vault.databinding.ItemCredentialBinding
import com.automate.vault.model.CredentialRecord
import java.text.DateFormat
import java.util.Date

/**
 * RecyclerView adapter for credential metadata records.
 * Never handles, stores, or logs decrypted secrets.
 */
class CredentialAdapter(
    private val onRevealClick: (CredentialRecord) -> Unit,
    private val onDeleteClick: (CredentialRecord) -> Unit
) : ListAdapter<CredentialRecord, CredentialAdapter.ViewHolder>(DiffCallback) {

    private val dateFormat = DateFormat.getDateInstance(DateFormat.MEDIUM)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemCredentialBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(
        private val binding: ItemCredentialBinding
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(item: CredentialRecord) {
            binding.tvCredentialOrigin.text = item.origin
            binding.tvCredentialUsername.text = item.username

            val dateStr = dateFormat.format(Date(item.createdAt))
            binding.tvCredentialDate.text = binding.root.context.getString(
                R.string.status_hardware_backed
            ) + " • " + dateStr

            binding.btnRevealCredential.setOnClickListener {
                onRevealClick(item)
            }

            binding.btnDeleteCredential.setOnClickListener {
                onDeleteClick(item)
            }
        }
    }

    private object DiffCallback : DiffUtil.ItemCallback<CredentialRecord>() {
        override fun areItemsTheSame(oldItem: CredentialRecord, newItem: CredentialRecord): Boolean {
            return oldItem.id == newItem.id
        }

        override fun areContentsTheSame(oldItem: CredentialRecord, newItem: CredentialRecord): Boolean {
            return oldItem == newItem
        }
    }
}
