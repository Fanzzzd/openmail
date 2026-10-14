import { MailError } from "@openmail/core/schema";
import { Schema } from "effect";

export const AccountIds = Schema.optionalKey(Schema.Array(Schema.String));
export const error = MailError;
