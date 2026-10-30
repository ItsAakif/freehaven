package expo.modules.backgroundgeneration

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS surface for the background generation foreground service.
 *
 * Every call is best-effort: a missing React context or a platform that
 * refuses to start the service returns `false` instead of throwing, so a
 * notification failure can never fail a generation job.
 */
class BackgroundGenerationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackgroundGeneration")

    AsyncFunction("start") { title: String, text: String ->
      runSafely { context ->
        BackgroundGenerationService.start(context, title, text)
      }
    }

    AsyncFunction("update") { text: String, progress: Double ->
      runSafely { context ->
        BackgroundGenerationService.update(context, text, progress)
      }
    }

    AsyncFunction("stop") {
      runSafely { context ->
        BackgroundGenerationService.stop(context)
      }
    }
  }

  private fun runSafely(block: (Context) -> Unit): Boolean {
    val context = appContext.reactContext ?: return false
    return try {
      block(context)
      true
    } catch (_: Exception) {
      false
    }
  }
}
