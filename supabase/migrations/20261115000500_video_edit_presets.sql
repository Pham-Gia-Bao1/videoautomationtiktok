alter table public.episode_video_subtitle_styles
  add column if not exists preset text not null default 'podcast'
    check (preset in ('tiktok','cinematic','meme','minimal','storytelling','podcast','energetic')),
  add column if not exists intensity text not null default 'balanced'
    check (intensity in ('subtle','balanced','creative'));
