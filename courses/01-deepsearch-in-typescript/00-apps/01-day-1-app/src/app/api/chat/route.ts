import type { UIMessage } from "ai";
import {
  streamText,
  convertToModelMessages,
  createTextStreamResponse,
} from "ai";
import { auth } from "~/server/auth";
import { model } from "~/model";

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
  });

  return createTextStreamResponse(result);
}
