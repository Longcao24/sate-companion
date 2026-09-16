package expo.modules.satefgservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the app's process alive while a recorder is connected over Bluetooth.
 *
 * This service does NOT do any Bluetooth work itself. The BLE link, the L816
 * protocol and the upload all stay in JavaScript where they already live and are
 * already tested — reimplementing them natively would mean two implementations
 * of a transfer that must never corrupt a recording.
 *
 * What it buys is the one thing JavaScript cannot give itself: Android stops
 * scheduling a backgrounded app's work, so the L816's 3-second state poll dies
 * the moment the user leaves the screen, and with it the whole point of
 * detecting a take started on the device's own button. A foreground service
 * keeps the process running normally, timers included.
 *
 * START_NOT_STICKY, and it stops when the task is removed, both deliberately —
 * see the comments below. A notification that says "connected" when the code
 * owning the connection is gone is worse than no notification.
 */
class SateForegroundService : Service() {

  companion object {
    const val CHANNEL_ID = "sate_device_link"
    const val NOTIF_ID = 4816
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_PROGRESS = "progress" // 0..100, or -1 for none

    fun buildNotification(ctx: Context, title: String, text: String, progress: Int): Notification {
      // Tapping the notification returns to the app rather than doing nothing —
      // this is the only affordance a user has while the app is in the background.
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val pending = launch?.let {
        it.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        PendingIntent.getActivity(
          ctx, 0, it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
      }

      val b = NotificationCompat.Builder(ctx, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(text)
        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
      if (pending != null) b.setContentIntent(pending)
      // A transfer has a real byte count, so it gets a real bar. Everything else
      // gets none — never a fake one.
      if (progress in 0..100) b.setProgress(100, progress, false)
      return b.build()
    }

    fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Recorder connection",
        // LOW: this is a persistent status notification, not an alert. It must
        // never buzz a clinician's phone during a session.
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Shown while SATE is connected to a recorder over Bluetooth."
        setShowBadge(false)
      }
      mgr.createNotificationChannel(channel)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel(this)
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "SATE"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Connected to your recorder"
    val progress = intent?.getIntExtra(EXTRA_PROGRESS, -1) ?: -1
    startForeground(NOTIF_ID, buildNotification(this, title, text, progress))

    // START_NOT_STICKY: if Android kills us under memory pressure, do NOT let it
    // restart the service on its own. It would come back with no JavaScript
    // runtime behind it — a notification claiming a live connection that nothing
    // is holding. Dying quietly is the honest failure.
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The user swiped the app away. That is an explicit "stop", distinct from
    // backgrounding it, and the RN activity is gone — so the link is going with
    // it whatever we do here. Clear the notification instead of leaving one that
    // outlives what it describes.
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }
}
