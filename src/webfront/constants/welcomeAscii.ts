import { platform } from '../stores/platformStore';

const workxAsciiLines: Array<{ text: string; color: string }> = [
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
  ? workxAsciiLines
  : piAsciiLines;
