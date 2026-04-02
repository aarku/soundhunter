# SoundHunter - Ideas & Changes

## Future

- [ ] Don't duplicate things in lists. When you drag in a second time, it should just do a move so it appears where you "dropped" it.
- [ ] Virtualized list for browsing all sounds (10k-30k+ scale)
- [ ] Make lists renameable, reorderable.
- [ ] CLAP model for audio+text shared embedding space (search by sound content, find similar sounds)
- [ ] Auto-tagging via YAMNet or AudioSpectrogram Transformer locally using onnxruntime-rs

## Bugs

## Completed

- [x] Right click on search result to remove it from the results... resets if you clear it with the X. At the end of the list it'll show "...and X results that have been temporarily hidden. Click to show."
- [x] Some wav files don't show a duration (files with JUNK chunks before fmt)
- [x] Button to create a new list from the search results that are currently shown.
