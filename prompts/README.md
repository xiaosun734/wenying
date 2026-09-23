# 提示词文件

每个提示词变量对应一个独立文件，默认从项目根目录的 `prompts/` 读取。

| 环境变量名 | 文件 |
| --- | --- |
| `LLM_REWRITE_SYSTEM_PROMPT` | `rewrite/system.txt` |
| `LLM_REWRITE_USER_PROMPT_TEMPLATE` | `rewrite/user.txt` |
| `LLM_SHOT_SYSTEM_PROMPT` | `shot/system.txt` |
| `LLM_SHOT_USER_PROMPT_TEMPLATE` | `shot/user.txt` |
| `LLM_VISUAL_BIBLE_SYSTEM_PROMPT` | `visual-bible/system.txt` |
| `LLM_VISUAL_BIBLE_USER_PROMPT_TEMPLATE` | `visual-bible/user.txt` |
| `LLM_DIRECTOR_SYSTEM_PROMPT` | `director/system.txt` |
| `LLM_DIRECTOR_USER_PROMPT_TEMPLATE` | `director/user.txt` |
| `LLM_CAMERA_SYSTEM_PROMPT` | `camera/system.txt` |
| `LLM_CAMERA_USER_PROMPT_TEMPLATE` | `camera/user.txt` |
| `LLM_STORYBOARD_SYSTEM_PROMPT` | `storyboard/system.txt` |
| `LLM_STORYBOARD_USER_PROMPT_TEMPLATE` | `storyboard/user.txt` |
| `VIDEO_DEFAULT_PROMPT_TEMPLATE` | `video/default.txt` |
| `VIDEO_FALLBACK_SHOT_PROMPT_TEMPLATE` | `video/fallback-shot.txt` |
| `VIDEO_FINAL_FALLBACK_PROMPT_TEMPLATE` | `video/final-fallback.txt` |
| `COMFYUI_IMAGE_NEGATIVE_PROMPT` | `image/negative.txt` |
| `COMFYUI_NEGATIVE_PROMPT` | `video/negative.txt` |

文件中的内容会直接作为提示词。用户模板占位符使用 `{name}`，例如 `{genre}`、`{background}`、`{segments}`。

每个文件顶部可以写维护注释。以 `#` 开头的整行会在发送给模型前自动剔除，不会进入实际提示词。

环境变量仍然可以覆盖文件内容，适合临时部署或单个环境替换。未设置同名环境变量时，服务读取这里的文件。设置 `PROMPTS_DIR` 可以替换整个提示词目录。
