<template>
  <RobotVR />
</template>

<script setup>
import RobotVR from './components/RobotVR.vue';
</script>

<style>
/* 确保全屏显示 */
html, body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}
#app {
  width: 100vw;
  height: 100vh;
}
</style>