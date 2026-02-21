<script lang="ts">
  import { _t } from '../extension/sidepanel/lib/i18n';

  function handleGetStarted() {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    window.close();
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
  <div class="max-w-2xl mx-auto p-8 bg-white dark:bg-gray-800 rounded-lg shadow-xl">
    <h1 class="text-4xl font-bold text-gray-900 dark:text-white mb-4">
      {$_t("Welcome to Browserx")}
    </h1>

    <p class="text-lg text-gray-600 dark:text-gray-300 mb-6">
      {$_t("Your AI-powered browser assistant is ready to help you navigate, understand, and interact with web content.")}
    </p>

    <div class="space-y-4">
      <h2 class="text-2xl font-semibold text-gray-800 dark:text-gray-200">{$_t("Quick Start")}</h2>

      <div class="space-y-3">
        <div class="flex items-start space-x-3">
          <span class="text-blue-500 text-xl">→</span>
          <div>
            <strong class="text-gray-800 dark:text-gray-200">{$_t("Open Side Panel:")}</strong>
            <span class="text-gray-600 dark:text-gray-400">
              {$_t("Click the Browserx icon in your toolbar or press Alt+Shift+C")}
            </span>
          </div>
        </div>

        <div class="flex items-start space-x-3">
          <span class="text-blue-500 text-xl">→</span>
          <div>
            <strong class="text-gray-800 dark:text-gray-200">{$_t("Use Context Menu:")}</strong>
            <span class="text-gray-600 dark:text-gray-400">
              {$_t("Right-click on any text to explain or improve it with Browserx")}
            </span>
          </div>
        </div>

        <div class="flex items-start space-x-3">
          <span class="text-blue-500 text-xl">→</span>
          <div>
            <strong class="text-gray-800 dark:text-gray-200">{$_t("Extract Data:")}</strong>
            <span class="text-gray-600 dark:text-gray-400">
              {$_t("Ask Browserx to extract structured data from any webpage")}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
      <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-3">
        {$_t("Keyboard Shortcuts")}
      </h3>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded">Alt+Shift+C</kbd>
          <span class="ml-2 text-gray-600 dark:text-gray-400">{$_t("Toggle side panel")}</span>
        </div>
        <div>
          <kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded">Alt+Shift+Q</kbd>
          <span class="ml-2 text-gray-600 dark:text-gray-400">{$_t("Quick action")}</span>
        </div>
      </div>
    </div>

    <div class="mt-8 flex justify-center">
      <button
        on:click={handleGetStarted}
        class="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
      >
        {$_t("Get Started")}
      </button>
    </div>
  </div>
</div>
