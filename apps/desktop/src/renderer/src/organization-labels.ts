import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

type Translate = (message: MessageDescriptor) => string;

export function categoryNames(t: Translate) {
  return {
    CATEGORY_PERSONAL: t(msg`Primary`),
    CATEGORY_SOCIAL: t(msg`Social`),
    CATEGORY_PROMOTIONS: t(msg`Promotions`),
    CATEGORY_UPDATES: t(msg`Updates`),
    CATEGORY_FORUMS: t(msg`Forums`),
  };
}

export function importanceNames(t: Translate) {
  return { low: t(msg`Low`), normal: t(msg`Normal`), high: t(msg`High`) };
}
