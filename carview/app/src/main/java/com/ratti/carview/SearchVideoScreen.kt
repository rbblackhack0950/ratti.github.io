package com.ratti.carview

import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.Template

/** Search box shown on the car screen (uses the car's keyboard or voice input). */
class SearchVideoScreen(
    carContext: CarContext,
    private val onSearch: (String) -> Unit,
) : Screen(carContext) {

    override fun onGetTemplate(): Template {
        val callback = object : SearchTemplate.SearchCallback {
            override fun onSearchTextChanged(searchText: String) = Unit

            override fun onSearchSubmitted(searchText: String) {
                val query = searchText.trim()
                if (query.isEmpty()) return
                onSearch(query)
                screenManager.pop()
            }
        }
        return SearchTemplate.Builder(callback)
            .setHeaderAction(Action.BACK)
            .setSearchHint("ค้นหาวิดีโอ YouTube")
            .setShowKeyboardByDefault(true)
            .setItemList(
                ItemList.Builder()
                    .setNoItemsMessage("พิมพ์คำค้นหา แล้วกดค้นหา")
                    .build(),
            )
            .build()
    }
}
