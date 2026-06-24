import { type ComponentProps } from "solid-js"
import { PixelWordmark } from "../../components/pixel-wordmark"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return <PixelWordmark class={props.class} opacity={0.16} />
}
