package expo.modules.satefgservice

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS-facing control for the foreground service that keeps a recorder connection
// alive while the app is in the background. See SateForegroundService for why
// this exists at all; this file is only the switch.

private const val DONE_NOTIF_BASE = 4900

class SateFgServiceModule : Module() {

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "No Android context" }

  private fun canPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
  }

  override fun definition() = ModuleDefinition {
    Name("SateFgService")

    // Android 13+ needs runtime consent before the ongoing notification can be
    // shown — and a foreground service with no visible notification is not a
    // thing Android allows. The JS side asks before it tries to start.
    Function("hasNotificationPermission") { canPostNotifications() }

    /**
     * Start (or update) the ongoing notification and keep the process alive.
     * Safe to call repeatedly: Android delivers a fresh onStartCommand and the
     * notification is replaced in place, so this doubles as "update the text".
     */
    Function("start") { title: String, text: String, progress: Int ->
      val intent = Intent(context, SateForegroundService::class.java).apply {
        putExtra(SateForegroundService.EXTRA_TITLE, title)
        putExtra(SateForegroundService.EXTRA_TEXT, text)
        putExtra(SateForegroundService.EXTRA_PROGRESS, progress)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      true
    }

    Function("stop") {
      context.stopService(Intent(context, SateForegroundService::class.java))
      true
    }

    /**
     * A one-off notification — used to tell the user a recording finished
     * transferring while they were elsewhere. Distinct from the ongoing one:
     * this is the moment worth interrupting for, and it is the only way they
     * learn a take arrived without opening the app.
     */
    Function("notifyOnce") { id: Int, title: String, text: String ->
      if (!canPostNotifications()) return@Function false
      SateForegroundService.ensureChannel(context)
      val n = SateForegroundService.buildNotification(context, title, text, -1)
      // buildNotification marks the ongoing one persistent; a completion notice
      // must be dismissible, or the user is left with a notice they cannot clear.
      val dismissible = android.app.Notification.Builder.recoverBuilder(context, n)
        .setOngoing(false)
        .setAutoCancel(true)
        .build()
      val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      mgr.notify(DONE_NOTIF_BASE + (id and 0xff), dismissible)
      true
    }

    Function("areNotificationsEnabled") {
      NotificationManagerCompat.from(context).areNotificationsEnabled()
    }
  }
}
