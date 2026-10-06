import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { OUTLOOK_OTHER } from "./view";

type Translate = (message: MessageDescriptor) => string;

export function categoryNames(t: Translate, outlook = false) {
  return {
    CATEGORY_PERSONAL: t(outlook ? msg`Focused` : msg`Primary`),
    CATEGORY_OTHER: t(OUTLOOK_OTHER),
    CATEGORY_SOCIAL: t(msg`Social`),
    CATEGORY_PROMOTIONS: t(msg`Promotions`),
    CATEGORY_UPDATES: t(msg`Updates`),
    CATEGORY_FORUMS: t(msg`Forums`),
  };
}

export function importanceNames(t: Translate) {
  return { low: t(msg`Low`), normal: t(msg`Normal`), high: t(msg`High`) };
}
