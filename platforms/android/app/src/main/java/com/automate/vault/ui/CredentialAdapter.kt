package com.automate.vault.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.automate.vault.R
import com.automate.vault.databinding.ItemCredentialBinding
import com.automate.vault.model.CredentialRecord

/**
 * RecyclerView adapter for credential records.
 * Locked records show ONLY opaque identifiers and envelope status;
 * origin, username, and timestamps remain completely hidden until authenticated.
 */
class CredentialAdapter(
    private val onRevealClick: (CredentialRecord) -> Unit,
    private val onUpgradeClick: (CredentialRecord.V1) -> Unit,
    private val onDeleteClick: (CredentialRecord) -> Unit
) : ListAdapter<CredentialRecord, CredentialAdapter.ViewHolder>(DiffCallback) {

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
            val shortId = if (item.id.length >= 8) item.id.substring(0, 8) else item.id

            when (item) {
                is CredentialRecord.V2 -> {
                    binding.tvCredentialOrigin.text = binding.root.context.getString(
                        R.string.locked_v2_title,
                        shortId
                    )
                    binding.tvCredentialUsername.text = binding.root.context.getString(
                        R.string.locked_v2_subtitle
                    )
                    binding.tvCredentialDate.text = binding.root.context.getString(
                        R.string.locked_v2_badge
                    )
                    binding.btnUpgradeCredential.visibility = View.GONE
                }
                is CredentialRecord.V1 -> {
                    binding.tvCredentialOrigin.text = binding.root.context.getString(
                        R.string.locked_v1_title,
                        shortId
                    )
                    binding.tvCredentialUsername.text = binding.root.context.getString(
                        R.string.locked_v1_subtitle
                    )
                    binding.tvCredentialDate.text = binding.root.context.getString(
                        R.string.locked_v1_badge
                    )
                    binding.btnUpgradeCredential.visibility = View.VISIBLE
                    binding.btnUpgradeCredential.setOnClickListener {
                        onUpgradeClick(item)
                    }
                }
            }

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
