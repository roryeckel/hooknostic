"""LiteLLM sidecar hook for the drift lane's paid llm transport.

Some upstream chat templates accept a system message only at the start of the
conversation, but Claude Code's requests reach the chat-completions bridge with
a system-role block after the first user turn. Merge every system message into
one leading system message. This only reshapes the model-side request; the
harness's hook payloads are untouched.
"""

from litellm.integrations.custom_logger import CustomLogger


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n\n".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


class MergeSystemMessages(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        messages = data.get("messages")
        if not isinstance(messages, list):
            return data
        system = [m for m in messages if isinstance(m, dict) and m.get("role") == "system"]
        if not system or (messages and messages[0] is system[0] and len(system) == 1):
            return data
        rest = [m for m in messages if not (isinstance(m, dict) and m.get("role") == "system")]
        merged = "\n\n".join(part for part in (_text(m.get("content")) for m in system) if part)
        data["messages"] = [{"role": "system", "content": merged}, *rest]
        return data


handler = MergeSystemMessages()
