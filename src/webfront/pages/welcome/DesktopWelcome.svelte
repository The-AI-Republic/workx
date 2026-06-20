<script lang="ts">
  type WelcomeStep = {
    title: string;
    eyebrow: string;
    body: string;
    points: string[];
  };

  let { onComplete }: {
    onComplete?: () => void | Promise<void>;
  } = $props();

  const steps: WelcomeStep[] = [
    {
      eyebrow: 'Step 1 of 3',
      title: 'Start with a direct request',
      body: 'WorkX opens to a conversation. Ask for the outcome you want and include the app, site, or files it should use.',
      points: [
        'Use the message box for everyday tasks.',
        'Open a new thread when the task changes.',
        'Review tool requests before approving sensitive actions.',
      ],
    },
    {
      eyebrow: 'Step 2 of 3',
      title: 'Connect your model access',
      body: 'Use Settings when you need to sign in, choose a model, or add your own API key for direct provider access.',
      points: [
        'Open Settings from the left navigation or footer.',
        'Pick the provider and model that fit the job.',
        'API keys stay stored locally by the configured credential store.',
      ],
    },
    {
      eyebrow: 'Step 3 of 3',
      title: 'Use desktop capabilities',
      body: 'WorkX can run desktop-oriented workflows such as scheduled tasks, memory, skills, and code-mode workspaces when enabled.',
      points: [
        'Use Scheduler for tasks that should run later.',
        'Enable Memory only when you want cross-conversation recall.',
        'Set a workspace before using code-mode file tools.',
      ],
    },
  ];

  let currentStep = $state(0);
  let completing = $state(false);
  let errorMessage = $state('');

  const isFirstStep = $derived(currentStep === 0);
  const isLastStep = $derived(currentStep === steps.length - 1);
  const step = $derived(steps[currentStep]);

  function previousStep() {
    if (!isFirstStep) {
      currentStep -= 1;
    }
  }

  function nextStep() {
    if (!isLastStep) {
      currentStep += 1;
    }
  }

  async function completeGuide() {
    if (completing) return;
    completing = true;
    errorMessage = '';
    try {
      await onComplete?.();
    } catch (error) {
      console.warn('[DesktopWelcome] Failed to complete guide:', error);
      errorMessage = 'Could not save this preference. Try again.';
      completing = false;
    }
  }
</script>

<section class="h-full min-h-0 overflow-auto bg-chat-bg text-chat-text dark:bg-chat-bg-dark dark:text-chat-text-dark">
  <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-5 py-8 sm:px-8 lg:px-10">
    <div class="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(320px,1.1fr)] lg:items-center">
      <div class="space-y-6">
        <div class="space-y-3">
          <p class="text-sm font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
            Welcome to WorkX
          </p>
          <h1 class="max-w-xl text-4xl font-semibold leading-tight text-chat-text dark:text-chat-text-dark sm:text-5xl">
            A quick guide before your first task
          </h1>
          <p class="max-w-xl text-base leading-7 text-chat-text-secondary dark:text-chat-text-secondary-dark">
            Three short notes to help you find the main controls and avoid surprises on the first run.
          </p>
        </div>

        <div class="flex items-center gap-2" aria-label="Guide progress">
          {#each steps as _, index (index)}
            <span
              class="h-2 rounded-full transition-all {index === currentStep
                ? 'w-10 bg-emerald-600 dark:bg-emerald-400'
                : 'w-2.5 bg-chat-border dark:bg-chat-border-dark'}"
            ></span>
          {/each}
        </div>
      </div>

      <article class="rounded-lg border border-chat-border bg-chat-card p-6 shadow-sm dark:border-chat-card-border-dark dark:bg-chat-card-dark sm:p-7">
        <div class="mb-6 flex items-start justify-between gap-4">
          <div class="space-y-2">
            <p class="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
              {step.eyebrow}
            </p>
            <h2 class="text-2xl font-semibold leading-snug text-chat-text dark:text-chat-text-dark">
              {step.title}
            </h2>
          </div>
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-lg font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            {currentStep + 1}
          </div>
        </div>

        <p class="mb-5 text-sm leading-6 text-chat-text-secondary dark:text-chat-text-secondary-dark">
          {step.body}
        </p>

        <ul class="space-y-3">
          {#each step.points as point (point)}
            <li class="flex gap-3 text-sm leading-6 text-chat-text dark:text-chat-text-dark">
              <span class="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-400"></span>
              <span>{point}</span>
            </li>
          {/each}
        </ul>

        {#if errorMessage}
          <p class="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
            {errorMessage}
          </p>
        {/if}

        <div class="mt-8 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            class="rounded-md border border-chat-border px-4 py-2 text-sm font-medium text-chat-text transition-colors hover:bg-chat-card-hover disabled:cursor-not-allowed disabled:opacity-45 dark:border-chat-border-dark dark:text-chat-text-dark dark:hover:bg-chat-card-hover-dark"
            disabled={isFirstStep || completing}
            onclick={previousStep}
          >
            Back
          </button>

          <div class="flex items-center gap-3">
            <button
              type="button"
              class="rounded-md px-4 py-2 text-sm font-medium text-chat-text-secondary transition-colors hover:bg-chat-card-hover disabled:cursor-not-allowed disabled:opacity-60 dark:text-chat-text-secondary-dark dark:hover:bg-chat-card-hover-dark"
              disabled={completing}
              onclick={completeGuide}
            >
              Skip
            </button>

            {#if isLastStep}
              <button
                type="button"
                class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:text-gray-950 dark:hover:bg-emerald-400"
                disabled={completing}
                onclick={completeGuide}
              >
                {completing ? 'Saving...' : 'Start using WorkX'}
              </button>
            {:else}
              <button
                type="button"
                class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:text-gray-950 dark:hover:bg-emerald-400"
                disabled={completing}
                onclick={nextStep}
              >
                Next
              </button>
            {/if}
          </div>
        </div>
      </article>
    </div>
  </div>
</section>
