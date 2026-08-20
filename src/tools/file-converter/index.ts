import { FileExport } from '@vicons/tabler';
import { defineTool } from '../tool';

export const tool = defineTool({
  name: 'File converter',
  path: '/file-converter',
  description: 'Convert files between formats using a self-hosted ConvertX backend.',
  keywords: [
    'file', 'convert', 'converter', 'format', 'transcode',
    'mp4', 'mkv', 'webm', 'mp3', 'wav', 'flac',
    'png', 'jpg', 'webp', 'avif', 'heic', 'svg',
    'pdf', 'docx', 'odt', 'epub', 'mobi', 'csv',
  ],
  component: () => import('./file-converter.vue'),
  icon: FileExport,
  createdAt: new Date('2026-08-19'),
});
