import { platform } from '../stores/platformStore';

const browserxAsciiLines: Array<{ text: string; color: string }> = [
  { text: '██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗███████╗██████╗ ██╗  ██╗', color: 'text-term-blue' },
  { text: '██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔════╝██╔══██╗╚██╗██╔╝', color: 'text-term-blue' },
  { text: '██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗█████╗  ██████╔╝ ╚███╔╝ ', color: 'text-term-blue' },
  { text: '██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║██╔══╝  ██╔══██╗ ██╔██╗ ', color: 'text-term-blue' },
  { text: '██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝███████║███████╗██║  ██║██╔╝ ██╗', color: 'text-term-blue' },
  { text: '╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝', color: 'text-term-blue' },
  { text: '', color: 'text-term-blue' }
];

const piAsciiLines: Array<{ text: string; color: string }> = [
  { text: ' █████╗ ██████╗ ██████╗ ██╗     ███████╗    ██████╗ ██╗', color: 'text-term-blue' },
  { text: '██╔══██╗██╔══██╗██╔══██╗██║     ██╔════╝    ██╔══██╗╚═╝', color: 'text-term-blue' },
  { text: '███████║██████╔╝██████╔╝██║     █████╗      ██████╔╝██╗', color: 'text-term-blue' },
  { text: '██╔══██║██╔═══╝ ██╔═══╝ ██║     ██╔══╝      ██╔═══╝ ██║', color: 'text-term-blue' },
  { text: '██║  ██║██║     ██║     ███████╗███████╗    ██║     ██║', color: 'text-term-blue' },
  { text: '╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚══════╝    ╚═╝     ╚═╝', color: 'text-term-blue' },
  { text: '', color: 'text-term-blue' }
];

export const welcomeAsciiLines = platform.platformName === 'extension'
  ? browserxAsciiLines
  : piAsciiLines;
