package expo.modules.t3speech

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.media.app.NotificationCompat.MediaStyle

/** Keeps a reading playing in the background and gives it lock screen, notification, and headset controls. */
class SpeechService : Service() {
  private lateinit var session: MediaSessionCompat
  private var title = ""
  private var paused = false

  override fun onCreate() {
    super.onCreate()
    session = MediaSessionCompat(this, TAG).apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() { SpeechPlayer.resume() }
        override fun onPause() { SpeechPlayer.pause() }
        override fun onRewind() { SpeechPlayer.rewind() }
        override fun onSkipToPrevious() { SpeechPlayer.rewind() }
        override fun onSkipToNext() { SpeechPlayer.nextBlock() }
        override fun onStop() { SpeechPlayer.stop {} }
      })
      isActive = true
    }
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_TOGGLE -> SpeechPlayer.togglePause()
      ACTION_REWIND -> SpeechPlayer.rewind()
      ACTION_NEXT -> SpeechPlayer.nextBlock()
      ACTION_STOP -> SpeechPlayer.stop {}
      else -> {
        title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
        paused = false
        show()
        starting = false
      }
    }
    stopIfIdle()
    return START_NOT_STICKY
  }

  /**
   * Stopping a service started with startForegroundService before it calls startForeground
   * crashes the app, so a reading that ends that early leaves stopping to onStartCommand.
   */
  private fun stopIfIdle() {
    if (starting || SpeechPlayer.isReading) return
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    instance = null
    session.release()
    super.onDestroy()
  }

  private fun show() {
    session.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "T3 Code")
        .build(),
    )
    session.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(
          PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_REWIND or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_STOP,
        )
        .setState(
          if (paused) PlaybackStateCompat.STATE_PAUSED else PlaybackStateCompat.STATE_PLAYING,
          PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
          1f,
        )
        .build(),
    )
    val notification = speechNotification(this, title)
      .setContentText("T3 Code")
      .setOngoing(!paused)
      .addAction(android.R.drawable.ic_media_rew, "Rewind 10 seconds", action(ACTION_REWIND))
      .addAction(
        if (paused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
        if (paused) "Resume reading" else "Pause reading",
        action(ACTION_TOGGLE),
      )
      .addAction(android.R.drawable.ic_media_next, "Next paragraph", action(ACTION_NEXT))
      .setDeleteIntent(action(ACTION_STOP))
      .setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
      .build()
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
  }

  private fun action(action: String) = PendingIntent.getService(
    this,
    action.hashCode(),
    Intent(this, SpeechService::class.java).setAction(action),
    PendingIntent.FLAG_IMMUTABLE,
  )

  companion object {
    private const val NOTIFICATION_ID = 0x7353
    private const val EXTRA_TITLE = "title"
    private const val ACTION_TOGGLE = "expo.modules.t3speech.TOGGLE"
    private const val ACTION_REWIND = "expo.modules.t3speech.REWIND"
    private const val ACTION_NEXT = "expo.modules.t3speech.NEXT"
    private const val ACTION_STOP = "expo.modules.t3speech.STOP"
    private val main = Handler(Looper.getMainLooper())
    private var instance: SpeechService? = null
    @Volatile private var starting = false

    /** Android refuses a foreground service, and audio focus, to an app in the background. */
    fun start(context: Context, title: String) {
      starting = true
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, SpeechService::class.java).putExtra(EXTRA_TITLE, title),
        )
      } catch (error: IllegalStateException) {
        starting = false
        Log.w(TAG, "could not start the playback service: ${error.message}")
        throw SpeechException("Open T3 Code to start reading aloud.")
      }
    }

    fun update(paused: Boolean) = main.post {
      val service = instance ?: return@post
      if (service.paused == paused) return@post
      service.paused = paused
      service.show()
    }

    fun stop() = main.post { instance?.stopIfIdle() }
  }
}

private var channelCreated = false

/** Main thread only. */
internal fun speechNotification(context: Context, title: String): NotificationCompat.Builder {
  if (!channelCreated) {
    NotificationManagerCompat.from(context).createNotificationChannel(
      NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW).setName("Voice").build(),
    )
    channelCreated = true
  }
  val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
  check(icon != 0) { "The notification_icon drawable is missing." }
  val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
  return NotificationCompat.Builder(context, CHANNEL_ID)
    .setSmallIcon(icon)
    .setContentTitle(title)
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .setSilent(true)
    .setShowWhen(false)
    .setContentIntent(launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE) })
}

private const val CHANNEL_ID = "t3-speech"
