import type { Message } from "ai";
import {
  streamText,
  createDataStreamResponse,
  appendResponseMessages,
} from "ai";
import { model } from "~/model";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";
import { bulkCrawlWebsites } from "~/scraper";
import { z } from "zod";
import { upsertChat } from "~/server/db/queries";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { chats } from "~/server/db/schema";
import { Langfuse } from "langfuse";
import { env } from "~/env";

const langfuse = new Langfuse({
  environment: env.NODE_ENV,
});

export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
    chatId: string;
    isNewChat: boolean;
  };

  const { messages, chatId, isNewChat } = body;

  const trace = langfuse.trace({
    sessionId: chatId,
    name: "chat",
    userId: session.user.id,
  });

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  // If this is a new chat, create it with the user's message
  if (isNewChat) {
    await upsertChat({
      userId: session.user.id,
      chatId,
      title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
      messages: messages, // Save the user's message initially
    });
  } else {
    // Verify the chat belongs to the user
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
    });
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  // Get current date and time for the system prompt
  const now = new Date();
  const currentDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const currentTime = now.toLocaleTimeString("en-US", {
    timeZoneName: "short",
  });

  return createDataStreamResponse({
    execute: async (dataStream) => {
      // If this is a new chat, send the chat ID to the frontend
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId,
        });
      }

      const result = streamText({
        model,
        messages,
        maxSteps: 10,
        experimental_telemetry: {
          isEnabled: true,
          functionId: `agent`,
          metadata: {
            langfuseTraceId: trace.id,
          },
        },
        system: `You are a helpful AI assistant with access to real-time web search capabilities and web scraping tools. 

CURRENT DATE AND TIME: ${currentDate} at ${currentTime}

When answering questions:

1. Always search the web for up-to-date information when relevant
2. ALWAYS format URLs as markdown links using the format [title](url)
3. Be thorough but concise in your responses
4. If you're unsure about something, search the web to verify
5. When providing information, always include the source where you found it using markdown links
6. Never include raw URLs - always use markdown link format
7. When you need detailed content from specific web pages, use the scrapePages tool to extract the full text content
8. The scrapePages tool is particularly useful when you need to analyze the content of articles, blog posts, or documentation pages
9. IMPORTANT: When using the scrapePages tool, always scrape 4-6 URLs per query to get comprehensive coverage
10. Always seek diverse sources - include different websites, perspectives, and types of content (news sites, blogs, documentation, academic sources, etc.)
11. Use the scrapePages tool aggressively to gather detailed information from multiple sources before providing comprehensive answers
12. Workflow: First search for relevant URLs, then scrape 4-6 diverse sources, then synthesize information from all scraped content
13. Prioritize scraping over just using search snippets - the full content provides much richer information
14. IMPORTANT: When users ask for "up to date" information, "latest", "current", or "recent" information, always check the publication dates of your sources and prioritize the most recent ones. Use the current date (${currentDate}) as a reference point to determine how recent the information is.
15. When providing information with dates, always mention how recent it is relative to the current date (e.g., "This information is from [date], which is [X] days/weeks/months ago from today").

Remember to use the searchWeb tool whenever you need to find current information, and use the scrapePages tool when you need to extract detailed content from specific web pages. Always aim for thorough coverage by scraping multiple diverse sources.`,
        tools: {
          searchWeb: {
            parameters: z.object({
              query: z.string().describe("The query to search the web for"),
            }),
            execute: async ({ query }, { abortSignal }) => {
              const results = await searchSerper(
                { q: query, num: 10 },
                abortSignal,
              );

              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
                date: result.date,
              }));
            },
          },
          scrapePages: {
            parameters: z.object({
              urls: z
                .array(z.string())
                .describe(
                  "Array of URLs to scrape and extract content from. IMPORTANT: Always provide 4-6 URLs for comprehensive coverage and diverse perspectives.",
                ),
            }),
            execute: async ({ urls }, { abortSignal }) => {
              const result = await bulkCrawlWebsites({ urls });

              if (!result.success) {
                return {
                  error: result.error,
                  results: result.results.map(({ url, result }) => ({
                    url,
                    success: result.success,
                    data: result.success ? result.data : result.error,
                  })),
                };
              }

              return {
                results: result.results.map(({ url, result }) => ({
                  url,
                  success: result.success,
                  data: result.data,
                })),
              };
            },
          },
        },
        onFinish: async ({ response }) => {
          // Merge the existing messages with the response messages
          const updatedMessages = appendResponseMessages({
            messages,
            responseMessages: response.messages,
          });

          const lastMessage = messages[messages.length - 1];
          if (!lastMessage) {
            return;
          }

          // Save the complete chat history with all messages
          await upsertChat({
            userId: session.user.id,
            chatId,
            title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
            messages: updatedMessages,
          });

          await langfuse.flushAsync();
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occurred!";
    },
  });
}
