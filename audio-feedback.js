export async function unlockSound(sound) {
  const originalVolume = sound.volume;
  try {
    sound.volume = 0;
    sound.currentTime = 0;
    await sound.play();
    sound.pause();
    sound.currentTime = 0;
    return true;
  } catch {
    return false;
  } finally {
    sound.volume = originalVolume;
  }
}

export async function playSound(sound) {
  try {
    sound.currentTime = 0;
    await sound.play();
    return true;
  } catch {
    return false;
  }
}
