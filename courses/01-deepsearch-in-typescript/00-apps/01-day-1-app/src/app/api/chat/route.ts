import type { UIMessage } from "ai";
import {
  streamText,
  convertToModelMessages,
  createTextStreamResponse,
} from "ai";
import { z } from "zod";
import { auth } from "~/server/auth";
import { model } from "~/model";
import { searchSerper } from "~/serper";

export const maxDuration = 60;

export async function POST(request: Request) {
  // Check if user is authenticated
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<UIMessage>;
  };

  const { messages } = body;

  const result = streamText({
    model,
    messages: convertToModelMessages(messages),
    system: `You are a helpful AI assistant with access to web search capabilities. 

IMPORTANT: You should ALWAYS use the search web tool when users ask questions that require current information, facts, or recent events. This includes:
- News and current events
- Recent developments in technology, science, or any field
- Specific facts, statistics, or information that might be outdated
- Questions about recent products, services, or companies
- Any topic where real-time or current information would be valuable

When you search the web:
1. Use the search web tool to find relevant information
2. Always cite your sources with inline links using the [title](link) format
3. Provide comprehensive, accurate answers based on the search results
4. If multiple sources provide different information, mention this and cite all relevant sources
5. IMPORTANT: Always format URLs as clickable markdown links using [title](URL) format - never show raw URLs
6. When citing sources, use descriptive titles that explain what the link contains

Only answer questions that don't require current information without searching. For everything else, search first, then provide a well-cited response.

Remember: Users should be able to click on your source links, so always use proper markdown link formatting [Source Name](URL).`,
    tools: {
      searchWeb: {
        inputSchema: z.object({
          query: z.string().describe("The query to search the web for"),
        }),
        execute: async (
          input: { query: string },
          options: { abortSignal?: AbortSignal },
        ) => {
          const results = await searchSerper(
            { q: input.query, num: 10 },
            options.abortSignal,
          );

          return results.organic.map((result) => ({
            title: result.title,
            link: result.link,
            snippet: result.snippet,
          }));
        },
      },
    },
  });

  return createTextStreamResponse(result);
}
