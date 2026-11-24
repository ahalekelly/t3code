package expo.modules.t3speech

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.car.app.connection.CarConnection
import androidx.lifecycle.Observer

/** Whether Android Auto is connected, and which Bluetooth audio devices are. */
class CarAudio(context: Context, private val onChange: () -> Unit) {
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private val connection = CarConnection(context).type
  @Volatile private var androidAuto = false

  private val connectionObserver = Observer<Int> { type ->
    androidAuto = type != CarConnection.CONNECTION_TYPE_NOT_CONNECTED
    onChange()
  }

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = onChange()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = onChange()
  }

  fun start() {
    main.post { connection.observeForever(connectionObserver) }
    audio.registerAudioDeviceCallback(deviceCallback, main)
  }

  fun stop() {
    main.post { connection.removeObserver(connectionObserver) }
    audio.unregisterAudioDeviceCallback(deviceCallback)
  }

  fun devices(): Map<String, Any> {
    val devices = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .filter { it.type in BLUETOOTH }
      // A device's A2DP and SCO outputs share its address.
      .distinctBy { it.address }
      .map { mapOf("id" to it.address, "name" to it.productName.toString()) }
    return mapOf("car" to androidAuto, "devices" to devices)
  }

  private companion object {
    val BLUETOOTH = setOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
    )
  }
}
