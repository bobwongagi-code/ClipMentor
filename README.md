# ClipMentor

**Turn shoppable reference videos into lessons creators can use.**

**English** · [简体中文](README_ZH.md)

ClipMentor helps creators and content teams understand **what makes a product demonstration work and how to film it**. It combines original video, explanation, captions and visual emphasis into an annotated breakdown, with a written storyboard to use while shooting.

## What You Get

| Your goal | Output |
| --- | --- |
| Understand a reference without studying every detail yourself | **Explained breakdown video** showing the product value, filming choices and details worth adapting |
| Keep a practical reference beside you while filming | **Source storyboard** describing the original sequence, actions and speech |
| Revise the lesson or adapt its presentation | **Editable project** retaining source clips, narration, captions, graphics and timeline |

A breakdown teaches the reasoning behind the reference. A source storyboard records what the reference actually does; a newly proposed script is a separate output.

## What a Teaching Point Looks Like

Illustrative example for a fabric-cleaning demonstration:

```text
Notice: The demonstration follows one stain through the cleaning process.
Why it matters: The viewer can connect the cleaning action to the result in that spot.
Try filming: Keep the same spot visible during use, then return to it for a clear result shot.
```

The explanation connects the product, the buyer's question and the visible evidence. Labels such as “close-up” or “good hook” are not enough on their own.

## How It Works

```text
Reference video + product information + intended audience
    → Select the useful teaching points
    → Prepare a blueprint with original playback and explanation
    → Review the content and filming guidance
    → Produce narration, captions and an editable video
    → Watch, revise and accept the finished output
```

The original video remains the reference. Product claims, visible results and suggested filming approaches stay distinguishable, and edits should preserve the meaning of the original speech and demonstration.

## Getting Started

- **Prepare a breakdown:** provide the complete reference video, product information, target language and intended output. The [bundled workflow](src/agent/skills/clipmentor/SKILL.md) guides the Agent-assisted planning and production process.
- **Run or develop the editor:** see [DEVELOPMENT.md](DEVELOPMENT.md) for setup, service configuration, commands and checks.
- **Review an output:** use the [delivery checklist](src/agent/skills/clipmentor/references/delivery-checklist.md), checking the actual video as well as its text and project.

## Project Status

ClipMentor is in active development. It has an editable video foundation, source-linked teaching plans and review tools. Current work combines Agent assistance with human content and final-video review; reliable unattended production and fixed time savings have not been established.

Local project storage does not mean every operation stays offline. Configured analysis, transcription, review and voice services may receive task material; use source media and services appropriate for the task.

## Upstream and License

ClipMentor is a modified version of [OpenChatCut](https://github.com/0xsline/OpenChatCut), by 0xsline and its contributors, and is not an official upstream release. Modification notice updated 2026-11-07.

The application retains [GNU AGPL-3.0-or-later](LICENSE), [Agent Skills attribution](src/agent/skills/NOTICE.md), [font licenses](assets/fonts/LICENSES.md) and applicable third-party notices. See [CLIPMENTOR.md](CLIPMENTOR.md) for provenance and recorded modifications. Upstream installers and releases belong to OpenChatCut.

[Development guide](DEVELOPMENT.md) · [Repository history](CHANGELOG.md) · [ClipMentor issues](https://github.com/bobwongagi-code/ClipMentor/issues)
