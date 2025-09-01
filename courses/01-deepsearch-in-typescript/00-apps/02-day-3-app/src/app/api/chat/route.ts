import type { Message } from "ai";
import { createDataStreamResponse, appendResponseMessages } from "ai";
import { auth } from "~/server/auth";
import { upsertChat } from "~/server/db/queries";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { chats } from "~/server/db/schema";
import { Langfuse } from "langfuse";
import { env } from "~/env";
import { streamFromDeepSearch } from "~/deep-search";

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

  // Create trace at the beginning to capture all operations
  const trace = langfuse.trace({
    name: "chat",
    userId: session.user.id,
  });

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  // If this is a new chat, create it with the user's message
  if (isNewChat) {
    const createChatSpan = trace.span({
      name: "create-new-chat",
      input: {
        userId: session.user.id,
        chatId,
        title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
        messageCount: messages.length,
      },
    });

    try {
      await upsertChat({
        userId: session.user.id,
        chatId,
        title: messages[messages.length - 1]!.content.slice(0, 50) + "...",
        messages: messages, // Save the user's message initially
      });

      createChatSpan.end({
        output: {
          success: true,
          chatId,
        },
      });
    } catch (error) {
      createChatSpan.end({
        output: {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
  } else {
    // Verify the chat belongs to the user
    const verifyChatSpan = trace.span({
      name: "verify-chat-ownership",
      input: {
        chatId,
        userId: session.user.id,
      },
    });

    try {
      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, chatId),
      });

      if (!chat || chat.userId !== session.user.id) {
        verifyChatSpan.end({
          output: {
            success: false,
            error: "Chat not found or unauthorized",
            chatFound: !!chat,
            chatUserId: chat?.userId,
          },
        });
        return new Response("Chat not found or unauthorized", { status: 404 });
      }

      verifyChatSpan.end({
        output: {
          success: true,
          chatId: chat.id,
          chatTitle: chat.title,
          chatUserId: chat.userId,
        },
      });
    } catch (error) {
      verifyChatSpan.end({
        output: {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      });
      throw error;
    }
  }

  // Update trace with sessionId now that we have confirmed the chatId
  trace.update({
    sessionId: chatId,
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

      const result = streamFromDeepSearch({
        messages,
        telemetry: {
          isEnabled: true,
          functionId: `agent`,
          metadata: {
            langfuseTraceId: trace.id,
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
          const saveChatHistorySpan = trace.span({
            name: "save-chat-history",
            input: {
              userId: session.user.id,
              chatId,
              title:
                messages[messages.length - 1]!.content.slice(0, 50) + "...",
              messageCount: updatedMessages.length,
            },
          });

          try {
            await upsertChat({
              userId: session.user.id,
              chatId,
              title:
                messages[messages.length - 1]!.content.slice(0, 50) + "...",
              messages: updatedMessages,
            });

            saveChatHistorySpan.end({
              output: {
                success: true,
                chatId,
                messageCount: updatedMessages.length,
              },
            });
          } catch (error) {
            saveChatHistorySpan.end({
              output: {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                chatId,
              },
            });
            throw error;
          }

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
