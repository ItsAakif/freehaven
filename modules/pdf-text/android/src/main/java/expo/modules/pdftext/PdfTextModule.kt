package expo.modules.pdftext

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException
import com.tom_roush.pdfbox.text.PDFTextStripper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Native PDF text extraction backed by PdfBox-Android.
 *
 * Runs on a worker thread because `AsyncFunction` is used. The result is a JSON
 * string rather than a list of maps so the Expo bridge only has to marshal one
 * primitive value. Every page is emitted, including pages with no text layer,
 * so the JS quality gate can tell a scanned PDF from a short one.
 */
class PdfTextModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PdfText")

    AsyncFunction("extractPages") { path: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("No Android context is available for PDF extraction.")
      PDFBoxResourceLoader.init(context.applicationContext)

      val file = File(path)
      if (!file.isFile) {
        throw IllegalArgumentException("PDF file not found: $path")
      }

      var document: PDDocument? = null
      try {
        val doc = try {
          PDDocument.load(file)
        } catch (error: InvalidPasswordException) {
          throw IllegalStateException("This PDF is password-protected and cannot be read.", error)
        } catch (error: IOException) {
          throw IllegalStateException("This PDF could not be opened: ${error.message}", error)
        }
        document = doc

        val pages = JSONArray()
        val stripper = PDFTextStripper().apply { sortByPosition = true }
        for (index in 1..doc.numberOfPages) {
          stripper.startPage = index
          stripper.endPage = index
          pages.put(
            JSONObject()
              .put("page", index)
              .put("text", stripper.getText(doc).trim())
          )
        }
        pages.toString()
      } finally {
        try {
          document?.close()
        } catch (_: IOException) {
          // Closing a document that was never fully loaded is harmless.
        }
      }
    }
  }
}
