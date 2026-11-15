alter table public.episode_video_subtitle_styles
  drop constraint if exists episode_video_subtitle_styles_animation_check;

alter table public.episode_video_subtitle_styles
  add constraint episode_video_subtitle_styles_animation_check
  check (animation in ('karaoke','word','fade','fade-out','pop','pop-out','bounce','typewriter','word-reveal','scale-punch','slide','shake','elastic','glitch','rotation','blur','wave','tracking','stagger','smooth','edit'));
