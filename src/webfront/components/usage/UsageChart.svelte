<script lang="ts">
  import { onMount, onDestroy, afterUpdate } from 'svelte';
  import {
    Chart,
    BarController,
    BarElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
  } from 'chart.js';
  import type { DailyUsageSummary } from '@/storage/types';
  import { _t } from '../../lib/i18n';

  Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

  export let dailySummaries: DailyUsageSummary[] = [];
  export let theme: string = 'modern';

  let canvas: HTMLCanvasElement;
  let chart: Chart | null = null;

  const TERMINAL_COLORS = ['#00ff00', '#00cccc', '#66ff66', '#33ffcc', '#00ff99', '#99ff66'];
  const MODERN_COLORS = ['#6366f1', '#8b5cf6', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b'];

  function getColors(): string[] {
    return theme === 'terminal' ? TERMINAL_COLORS : MODERN_COLORS;
  }

  function buildChartData() {
    const labels = dailySummaries.map((d) => d.date);
    const allModels = new Set<string>();
    for (const d of dailySummaries) {
      for (const model of Object.keys(d.byModel)) {
        allModels.add(model);
      }
    }
    const models = Array.from(allModels);
    const colors = getColors();

    const datasets = models.map((model, i) => ({
      label: model,
      data: dailySummaries.map((d) => d.byModel[model] || 0),
      backgroundColor: colors[i % colors.length],
      borderWidth: 0,
    }));

    return { labels, datasets };
  }

  function getChartOptions() {
    const textColor = theme === 'terminal' ? '#00ff00' : undefined;
    const gridColor = theme === 'terminal' ? 'rgba(0,255,0,0.15)' : undefined;

    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: textColor,
            font: theme === 'terminal' ? { family: 'monospace', size: 11 } : { size: 11 },
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} tokens`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: textColor, font: theme === 'terminal' ? { family: 'monospace', size: 10 } : { size: 10 } },
          grid: { color: gridColor },
        },
        y: {
          stacked: true,
          ticks: {
            color: textColor,
            font: theme === 'terminal' ? { family: 'monospace', size: 10 } : { size: 10 },
            callback: (value: any) => {
              if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
              if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
              return value;
            },
          },
          grid: { color: gridColor },
        },
      },
    };
  }

  function createChart() {
    if (!canvas || dailySummaries.length === 0) return;
    if (chart) chart.destroy();
    chart = new Chart(canvas, {
      type: 'bar',
      data: buildChartData(),
      options: getChartOptions() as any,
    });
  }

  onMount(() => {
    createChart();
  });

  afterUpdate(() => {
    if (chart) {
      chart.data = buildChartData();
      chart.options = getChartOptions() as any;
      chart.update();
    } else {
      createChart();
    }
  });

  onDestroy(() => {
    if (chart) {
      chart.destroy();
      chart = null;
    }
  });
</script>

{#if dailySummaries.length === 0}
  <div class="flex items-center justify-center h-full text-sm
    {theme === 'modern'
      ? 'text-chat-muted dark:text-chat-muted-dark font-chat'
      : 'text-term-dim-green font-terminal'}">
    {$_t('No chart data')}
  </div>
{:else}
  <canvas bind:this={canvas}></canvas>
{/if}
