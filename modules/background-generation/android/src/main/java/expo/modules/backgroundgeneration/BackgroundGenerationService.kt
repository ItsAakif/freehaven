package expo.modules.backgroundgeneration

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlin.math.roundToInt

/**
 * Keeps the existing JS context alive while a generation job runs.
 *
 * A `dataSync` foreground service plus a partial wake lock stops Android from
 * suspending the process when the app goes to the background. The ongoing
 * notification carries the generation stage and ETA range. The service is
 * deliberately not sticky: if the OS kills the process, the job row stays in
 * SQLite and the runner resumes from completed units on the next launch.
 */
class BackgroundGenerationService : Service() {

  companion object {
    const val ACTION_START = "expo.modules.backgroundgeneration.action.START"
    const val ACTION_UPDATE = "expo.modules.backgroundgeneration.action.UPDATE"
    const val ACTION_STOP = "expo.modules.backgroundgeneration.action.STOP"

    private const val CHANNEL_ID = "freehaven_generation"
    private const val CHANNEL_NAME = "Generation progress"
    private const val NOTIFICATION_ID = 4269
    private const val WAKE_LOCK_TAG = "freehaven:generation"
    private const val DEFAULT_TITLE = "Generating narration"
    private const val DEFAULT_TEXT = "Preparing generation..."

    private const val EXTRA_TITLE = "expo.modules.backgroundgeneration.TITLE"
    private const val EXTRA_TEXT = "expo.modules.backgroundgeneration.TEXT"
    private const val EXTRA_PROGRESS = "expo.modules.backgroundgeneration.PROGRESS"

    /** Starts (or restarts) the service and promotes it to the foreground. */
    fun start(context: Context, title: String, text: String) {
      val intent = Intent(context, BackgroundGenerationService::class.java).apply {
        action = ACTION_START
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_TEXT, text)
        putExtra(EXTRA_PROGRESS, -1)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    /** Refreshes the ongoing notification. Negative progress means indeterminate. */
    fun update(context: Context, text: String, progress: Double) {
      val percentage = if (progress < 0.0) -1 else progress.roundToInt().coerceIn(0, 100)
      val intent = Intent(context, BackgroundGenerationService::class.java).apply {
        action = ACTION_UPDATE
        putExtra(EXTRA_TEXT, text)
        putExtra(EXTRA_PROGRESS, percentage)
      }
      context.startService(intent)
    }

    /** Stops the service; onDestroy releases the wake lock and the notification. */
    fun stop(context: Context) {
      val intent = Intent(context, BackgroundGenerationService::class.java).apply {
        action = ACTION_STOP
      }
      try {
        context.startService(intent)
      } catch (_: Exception) {
        // Background service starts are restricted on API 26+; stopping the
        // service directly is always allowed and runs the same cleanup.
        context.stopService(Intent(context, BackgroundGenerationService::class.java))
      }
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var foregroundStarted = false
  private var notificationTitle: String = DEFAULT_TITLE

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> handleStart(intent)
      ACTION_UPDATE -> handleUpdate(intent)
      ACTION_STOP -> stopSelf()
      else -> stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun handleStart(intent: Intent) {
    acquireWakeLock()
    notificationTitle = intent.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    enterForeground(buildNotification(text, -1))
  }

  private fun handleUpdate(intent: Intent) {
    if (!foregroundStarted) {
      // An update can only be meaningful after START; never leave a started
      // service without its foreground notification.
      stopSelf()
      return
    }
    val text = intent.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    val progress = intent.getIntExtra(EXTRA_PROGRESS, -1)
    val notification = buildNotification(text, progress)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun enterForeground(notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundStarted = true
  }

  override fun onDestroy() {
    foregroundStarted = false
    releaseWakeLock()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(NOTIFICATION_ID)
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    try {
      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = powerManager
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
        .apply {
          setReferenceCounted(false)
          acquire()
        }
    } catch (_: Exception) {
      wakeLock = null
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.let { lock ->
        if (lock.isHeld) lock.release()
      }
    } catch (_: Exception) {
      // Releasing a lock that the system already dropped is harmless.
    } finally {
      wakeLock = null
    }
  }

  private fun buildNotification(text: String, progress: Int): Notification {
    ensureChannel()

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(notificationTitle)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

    if (progress >= 0) {
      builder.setProgress(100, progress.coerceIn(0, 100), false)
    } else {
      builder.setProgress(100, 0, true)
    }

    launchPendingIntent()?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows generation progress while Freehaven is in the background."
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun launchPendingIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(this, 0, intent, flags)
  }
}
