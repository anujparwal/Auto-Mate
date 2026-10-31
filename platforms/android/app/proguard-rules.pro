# Auto-Mate Vault ProGuard / R8 Rules

# Preserve data classes used with JSON serialization
-keepclassmembers class com.automate.vault.model.** { *; }

# Keep AndroidX Biometric internal interfaces
-keepclassmembers class androidx.biometric.** { *; }
