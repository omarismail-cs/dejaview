# déjàview

A Chrome extension that hides or dims reposted job postings on LinkedIn.

LinkedIn shows reposted jobs as if they were new. déjàview checks when each job was first posted, and if it is actually an old job that was reposted, it either removes it from the list or fades it and shows its real age.

## Install

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder.
5. Open a LinkedIn jobs search.

## Use

Click the déjàview icon and pick a mode:

- **Hide** removes reposted jobs from the list.
- **Dim** fades them and adds a badge like "First posted 8w ago".
- **Off** leaves LinkedIn alone.

## How it works

LinkedIn's job list does not say which jobs are reposts, so déjàview asks LinkedIn for each job's original posting date and compares it to the current one. If they are a day or more apart, the job counts as a repost.

Results are remembered in your browser so the same job is not checked twice.

## Good to know

- It can take a second or two for a new page of jobs to be checked.
- Everything stays in your browser. Nothing is sent anywhere except the lookups to LinkedIn itself.
- LinkedIn changes its site often, so this may break and need a fix.
- This is not affiliated with LinkedIn. Extensions that change the site are against its terms, so use it at your own risk.
