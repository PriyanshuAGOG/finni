import { z } from 'zod';
import { defineOperation } from '../registry';
import { invalidInput } from '../../lib/errors';
import { ingestFile } from '../../services/ingestion';

export const ingestFileOperation = defineOperation({
  operationId: 'ingestFile',
  method: 'POST',
  path: '/sources/ingest-file',
  summary: 'Upload and ingest a PDF or text file',
  description: `Uploads a file (PDF or plain text, sniffed by content rather than trusted by extension) and creates a source from it, queuing the same enrichment pipeline as a URL.

Use this only when the caller can actually supply a multipart file upload -- most Custom GPT conversations cannot, in which case suggest ingestUrl or createSource with pasted text instead. Duplicate files (identical content hash) return the existing source rather than creating a copy.

This operation writes. The created source is unreviewed.`,
  tags: ['sources', 'ingestion'],
  permission: 'source.create',
  scopes: ['source.write'],
  riskLevel: 'low',
  internalOnly: true,
  input: z.object({
    file: z.instanceof(File).optional(),
    collection_ids: z.array(z.string().uuid()).optional(),
    category_ids: z.array(z.string().uuid()).optional(),
    tags: z.array(z.string()).optional(),
  }),
  handler: async (input, { ctx }) => {
    if (!input.file) throw invalidInput('A file is required.');
    const body = Buffer.from(await input.file.arrayBuffer());
    return ingestFile(ctx, {
      filename: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      body,
      collectionIds: input.collection_ids,
      categoryIds: input.category_ids,
      tags: input.tags,
    });
  },
});
