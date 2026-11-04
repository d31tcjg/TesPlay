`two-audio.m4a` is a generated 0.2-second MP4 audio container with two silent AAC tracks, labelled English and Dutch. It contains no third-party media. It verifies actual container track discovery and validated file track selection without audio/video decoders.

Generated with FFmpeg using two `anullsrc=r=48000:cl=stereo` inputs, `-t 0.2 -map 0:a -map 1:a -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:1 language=nld -movflags +faststart`.
