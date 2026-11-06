package expo.modules.t3speech

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app running while work such as a transcription finishes in the background. Android
 * stops a short service after about three minutes, so ending a task twice is expected and ignored.
 * Main thread only.
 */
internal object BackgroundTasks {
  private val active = mutableSetOf<Int>()
  private var next = 0
  /** Set from startForegroundService until the service calls startForeground; stopping it in between crashes the app. */
  private var starting = false
  private var service: BackgroundTaskService? = null

  fun begin(context: Context, name: String): Int {
    val task = ++next
    if (active.isEmpty() && service == null && !starting) {
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, BackgroundTaskService::class.java).putExtra(BackgroundTaskService.EXTRA_NAME, name),
        )
        starting = true
      } catch (error: IllegalStateException) {
        Log.w(TAG, "could not start background task $name: ${error.message}")
      }
    }
    active.add(task)
    return task
  }

  fun end(task: Int) {
    if (active.remove(task)) stopIfIdle()
  }

  fun started(service: BackgroundTaskService) {
    this.service = service
    starting = false
    stopIfIdle()
  }

  fun expire() {
    active.clear()
    stopIfIdle()
  }

  private fun stopIfIdle() {
    if (active.isNotEmpty() || starting) return
    service?.stopSelf()
    service = null
  }
}

class BackgroundTaskService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = speechNotification(this, intent?.getStringExtra(EXTRA_NAME).orEmpty()).build()
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
    BackgroundTasks.started(this)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int) = expire()

  override fun onTimeout(startId: Int, fgsType: Int) = expire()

  private fun expire() {
    Log.w(TAG, "background task time ran out")
    BackgroundTasks.expire()
  }

  companion object {
    const val EXTRA_NAME = "name"
    private const val NOTIFICATION_ID = 0x7354
  }
}
