/*:
 * @target MZ
 * @plugindesc Draw an HP gauge with numeric readout above every visible enemy sprite in battle. Front-view battles show no enemy HP at all in stock MZ; this fills that gap.
 * @author rpgmaker-mcp examples
 * @help
 * No configuration, purely visual: it draws a child sprite on Sprite_Enemy
 * and never touches battle logic, troop events, or save data. Safe to add or
 * remove at any time.
 *
 * Works in front view and side view (stock MZ shows no enemy HP bar in
 * either). Hidden enemies (Enemy Appear events) keep the gauge hidden until
 * they appear.
 */
(() => {
  "use strict";

  const GAUGE_W = 56, GAUGE_H = 6, PAD = 2, TEXT_H = 16;

  function drawGauge(bitmap, enemy) {
    bitmap.clear();
    bitmap.fillRect(0, 0, bitmap.width, bitmap.height, "rgba(0,0,0,0.55)");
    const ratio = Math.max(0, enemy.hp / enemy.mhp);
    const color = ratio > 0.5 ? "#6fd84f" : ratio > 0.25 ? "#e7c34a" : "#e05340";
    bitmap.fillRect(PAD, PAD, Math.round((bitmap.width - PAD * 2) * ratio), GAUGE_H, color);
    bitmap.fontSize = 12;
    bitmap.textColor = "#ffffff";
    bitmap.outlineWidth = 3;
    bitmap.outlineColor = "rgba(0,0,0,0.8)";
    bitmap.drawText(`${enemy.hp}/${enemy.mhp}`, 0, GAUGE_H + PAD * 2, bitmap.width, TEXT_H, "center");
  }

  const aliasInitialize = Sprite_Enemy.prototype.initialize;
  Sprite_Enemy.prototype.initialize = function(battler) {
    aliasInitialize.apply(this, arguments);
    const bitmap = new Bitmap(GAUGE_W + PAD * 2, GAUGE_H + PAD * 2 + TEXT_H);
    this._hpGauge = new Sprite(bitmap);
    this._hpGauge.visible = false;
    this.addChild(this._hpGauge);
    this._hpGaugeRatio = -1;
  };

  const aliasUpdate = Sprite_Enemy.prototype.update;
  Sprite_Enemy.prototype.update = function() {
    aliasUpdate.apply(this, arguments);
    const gauge = this._hpGauge;
    const enemy = this._enemy;
    if (!gauge || !enemy) return;
    const visible = enemy.isAlive() && enemy.isAppeared();
    gauge.visible = visible;
    if (!visible) return;
    // Sprite_Enemy anchors at the feet (0.5, 1); lift the gauge above the head.
    const headroom = this.bitmap && this.bitmap.isReady() ? this.height : 48;
    gauge.move(-gauge.width / 2, -headroom - gauge.height - 4);
    if (enemy.hp / enemy.mhp !== this._hpGaugeRatio) {
      this._hpGaugeRatio = enemy.hp / enemy.mhp;
      drawGauge(gauge.bitmap, enemy);
    }
  };
})();
