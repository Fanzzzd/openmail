// Public surface for other features: always-loaded modules only (see tests/layers.test.ts).
export { MultiOrganizationItem } from "./MultiOrganization";
export {
  decodeDrag,
  DragLabel,
  DragMessages,
  FAVORITE_DRAG,
  LABEL_DRAG,
  MESSAGE_DRAG,
  sidebarDropOperation,
} from "./organize-drag";
export { OrganizationSettings } from "./OrganizationSettings";
export { ThreadMenuItems } from "./ThreadActions";
